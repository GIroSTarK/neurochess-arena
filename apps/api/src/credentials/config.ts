import { z } from "zod";

export const credentialKeyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}(?![\s\S])/);
const keySchema = z
  .string()
  .length(44)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.length === 32 && bytes.toString("base64") === value;
  });
export const credentialKeyringSchema = z
  .record(credentialKeyIdSchema, keySchema)
  .refine((keys) => Object.keys(keys).length >= 1 && Object.keys(keys).length <= 8);
export const credentialEncryptionConfigSchema = z
  .strictObject({ activeKeyId: credentialKeyIdSchema, keys: credentialKeyringSchema })
  .refine(({ activeKeyId, keys }) => Object.hasOwn(keys, activeKeyId));
export const credentialKeyringEnvironmentSchema = z
  .string()
  .min(1)
  .max(1024)
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      context.addIssue({ code: "custom" });
      return z.NEVER;
    }
  })
  .pipe(credentialKeyringSchema);
export type CredentialEncryptionConfig = z.infer<typeof credentialEncryptionConfigSchema>;
