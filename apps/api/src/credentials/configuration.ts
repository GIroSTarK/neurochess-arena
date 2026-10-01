import { z } from "zod";

export const credentialKeyIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export const credentialEncryptionKeySchema = z
  .string()
  .length(44)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.length === 32 && bytes.toString("base64") === value;
  });
