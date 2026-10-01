import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from "node:crypto";

import { aiProviderSchema, sessionApiKeySchema } from "@neurochess/contracts";
import { z } from "zod";

import { credentialEncryptionKeySchema, credentialKeyIdSchema } from "./configuration.js";

const contextIdSchema = z.uuid().transform((value) => value.toLowerCase());
const contextSchema = z.strictObject({
  userId: contextIdSchema,
  credentialId: contextIdSchema,
  provider: aiProviderSchema,
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  keyId: credentialKeyIdSchema,
  nonce: z.string().regex(/^[a-f0-9]{24}$/),
  authTag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z
    .string()
    .min(2)
    .max(8192)
    .regex(/^(?:[a-f0-9]{2})+$/),
});
export type EncryptedCredential = z.infer<typeof envelopeSchema>;
type CredentialContext = z.infer<typeof contextSchema>;

function aad(context: CredentialContext, keyId: string) {
  return Buffer.from(
    JSON.stringify([
      "neurochess-provider-credential",
      1,
      keyId,
      context.userId,
      context.provider,
      context.credentialId,
    ]),
  );
}

export function createCredentialCipher(input: { keyId: string; key: string }) {
  const config = z
    .strictObject({ keyId: credentialKeyIdSchema, key: credentialEncryptionKeySchema })
    .safeParse(input);
  if (!config.success) throw new Error("CREDENTIAL_CONFIGURATION_INVALID");
  const keyId = config.data.keyId;
  const key = createSecretKey(Buffer.from(config.data.key, "base64"));
  return {
    encrypt(contextInput: unknown, plaintextInput: unknown): EncryptedCredential {
      const context = contextSchema.safeParse(contextInput);
      const plaintext = sessionApiKeySchema.safeParse(plaintextInput);
      if (!context.success || !plaintext.success) throw new Error("CREDENTIAL_UNAVAILABLE");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(context.data, keyId));
      const ciphertext = Buffer.concat([cipher.update(plaintext.data, "utf8"), cipher.final()]);
      return {
        version: 1,
        keyId,
        nonce: nonce.toString("hex"),
        authTag: cipher.getAuthTag().toString("hex"),
        ciphertext: ciphertext.toString("hex"),
      };
    },
    decrypt(contextInput: unknown, envelopeInput: unknown): string {
      const context = contextSchema.safeParse(contextInput);
      const envelope = envelopeSchema.safeParse(envelopeInput);
      if (!context.success || !envelope.success || envelope.data.keyId !== keyId) {
        throw new Error("CREDENTIAL_UNAVAILABLE");
      }
      let pending: Buffer | undefined;
      let plaintext: Buffer | undefined;
      try {
        const record = envelope.data;
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "hex"), {
          authTagLength: 16,
        });
        decipher.setAAD(aad(context.data, keyId));
        decipher.setAuthTag(Buffer.from(record.authTag, "hex"));
        pending = decipher.update(Buffer.from(record.ciphertext, "hex"));
        // Never release update() output until final() verifies the authentication tag.
        plaintext = Buffer.concat([pending, decipher.final()]);
        const value = sessionApiKeySchema.safeParse(plaintext.toString("utf8"));
        if (!value.success) throw new Error();
        return value.data;
      } catch {
        throw new Error("CREDENTIAL_UNAVAILABLE");
      } finally {
        pending?.fill(0);
        plaintext?.fill(0);
      }
    },
  };
}

export type CredentialCipher = ReturnType<typeof createCredentialCipher>;
