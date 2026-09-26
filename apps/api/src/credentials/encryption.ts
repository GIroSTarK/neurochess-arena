import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from "node:crypto";

import { aiProviderSchema, sessionApiKeySchema } from "@neurochess/contracts";
import { z } from "zod";

import { credentialEncryptionConfigSchema, credentialKeyIdSchema } from "./config.js";

const contextSchema = z.strictObject({
  credentialId: z.uuid(),
  userId: z.string().min(1).max(256),
  provider: aiProviderSchema,
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  keyId: credentialKeyIdSchema,
  nonce: z.string().regex(/^[0-9a-f]{24}(?![\s\S])/),
  authTag: z.string().regex(/^[0-9a-f]{32}(?![\s\S])/),
  ciphertext: z
    .string()
    .min(2)
    .max(8192)
    .regex(/^(?:[0-9a-f]{2})+(?![\s\S])/),
});
type Context = z.infer<typeof contextSchema>;
type Envelope = z.infer<typeof envelopeSchema>;

export class CredentialEncryptionError extends Error {
  constructor() {
    super("CREDENTIAL_ENCRYPTION_FAILED");
    this.name = "CredentialEncryptionError";
  }
}

function additionalData(context: Context, envelope: Pick<Envelope, "version" | "keyId">) {
  return Buffer.from(
    JSON.stringify([
      "neurochess/provider-credential",
      envelope.version,
      envelope.keyId,
      context.userId,
      context.provider,
      context.credentialId,
    ]),
  );
}

export function createCredentialCipher(configuration: unknown) {
  const parsed = credentialEncryptionConfigSchema.safeParse(configuration);
  if (!parsed.success) throw new CredentialEncryptionError();
  const { activeKeyId } = parsed.data;
  const keys = new Map(
    Object.entries(parsed.data.keys).map(([id, value]) => {
      const bytes = Buffer.from(value, "base64");
      const key = createSecretKey(bytes);
      bytes.fill(0);
      return [id, key] as const;
    }),
  );
  return {
    encrypt(inputContext: Context, inputKey: string): Envelope {
      const context = contextSchema.safeParse(inputContext);
      const apiKey = sessionApiKeySchema.safeParse(inputKey);
      if (!context.success || !apiKey.success) throw new CredentialEncryptionError();
      const nonce = randomBytes(12);
      const header = { version: 1 as const, keyId: activeKeyId };
      const key = keys.get(activeKeyId);
      if (!key) throw new CredentialEncryptionError();
      const plaintext = Buffer.from(apiKey.data);
      try {
        const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
        cipher.setAAD(additionalData(context.data, header));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return {
          ...header,
          nonce: nonce.toString("hex"),
          authTag: cipher.getAuthTag().toString("hex"),
          ciphertext: ciphertext.toString("hex"),
        };
      } catch {
        // Crypto diagnostics and inputs must never escape this boundary.
        throw new CredentialEncryptionError();
      } finally {
        plaintext.fill(0);
      }
    },
    decrypt(inputContext: Context, inputEnvelope: unknown): string {
      const context = contextSchema.safeParse(inputContext);
      const envelope = envelopeSchema.safeParse(inputEnvelope);
      if (!context.success || !envelope.success) throw new CredentialEncryptionError();
      const { version, keyId, nonce, authTag, ciphertext } = envelope.data;
      const key = keys.get(keyId);
      if (!key) throw new CredentialEncryptionError();
      let pending: Buffer | undefined;
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "hex"), {
          authTagLength: 16,
        });
        decipher.setAAD(additionalData(context.data, { version, keyId }));
        decipher.setAuthTag(Buffer.from(authTag, "hex"));
        pending = decipher.update(Buffer.from(ciphertext, "hex"));
        // update() is unauthenticated until final() succeeds.
        plaintext = Buffer.concat([pending, decipher.final()]);
        const result = sessionApiKeySchema.safeParse(plaintext.toString("utf8"));
        if (!result.success) throw new CredentialEncryptionError();
        return result.data;
      } catch {
        throw new CredentialEncryptionError();
      } finally {
        pending?.fill(0);
        plaintext?.fill(0);
      }
    },
  };
}
export type CredentialCipher = ReturnType<typeof createCredentialCipher>;
