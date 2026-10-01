import { z } from "zod";

import { sessionApiKeySchema } from "./ai-http.js";
import { aiProviderSchema } from "./provider.js";

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{C}]+$/u);
export const credentialSaveRequestSchema = z
  .strictObject({
    credentialId: z.uuid(),
    save: z.literal(true),
    provider: aiProviderSchema,
    label: labelSchema,
    apiKey: sessionApiKeySchema,
  })
  .refine((value) => !value.label.includes(value.apiKey));
export const credentialMetadataSchema = z.strictObject({
  credentialId: z.uuid(),
  provider: aiProviderSchema,
  label: labelSchema,
  maskedSuffix: z
    .string()
    .regex(/^[A-Za-z0-9_-]{4}$/)
    .nullable(),
  createdAt: z.iso.datetime(),
});
export const credentialListResponseSchema = z.strictObject({
  credentials: z.array(credentialMetadataSchema).max(100),
});
export const credentialRevokeRequestSchema = z.strictObject({ credentialId: z.uuid() });
export const credentialClearRequestSchema = z.strictObject({ confirm: z.literal(true) });
export const credentialDeletedResponseSchema = z.strictObject({ status: z.literal("deleted") });
export const credentialErrorCodeSchema = z.enum([
  "CREDENTIAL_INVALID_REQUEST",
  "CREDENTIAL_UNAUTHORIZED",
  "CREDENTIAL_FORBIDDEN",
  "CREDENTIAL_CONFLICT",
  "CREDENTIAL_LIMIT_REACHED",
  "CREDENTIAL_UNAVAILABLE",
]);
export const credentialErrorResponseSchema = z.strictObject({
  code: credentialErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
});

export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>;
export type CredentialSaveRequest = z.infer<typeof credentialSaveRequestSchema>;
export type CredentialErrorCode = z.infer<typeof credentialErrorCodeSchema>;
