import { z } from "zod";

import { sessionApiKeySchema } from "./ai-http.js";
import { aiProviderSchema } from "./provider.js";

const credentialLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\p{C}<>]+$/u);
export const credentialSaveRequestSchema = z
  .strictObject({
    save: z.literal(true),
    provider: aiProviderSchema,
    label: z.string().trim().pipe(credentialLabelSchema),
    apiKey: sessionApiKeySchema,
  })
  .refine(({ label, apiKey }) => !label.includes(apiKey));
export const credentialMetadataSchema = z.strictObject({
  credentialId: z.uuid(),
  provider: aiProviderSchema,
  label: credentialLabelSchema,
  maskedSuffix: z
    .string()
    .regex(/^[A-Za-z0-9_-]{4}(?![\s\S])/)
    .nullable(),
  createdAt: z.iso.datetime(),
});
export const credentialListQuerySchema = z.strictObject({ after: z.uuid().optional() });
export const credentialListResponseSchema = z.strictObject({
  credentials: z.array(credentialMetadataSchema).max(50),
  nextCursor: z.uuid().nullable(),
});
export const credentialIdParamsSchema = z.strictObject({ credentialId: z.uuid() });
export const credentialRevokeRequestSchema = z.strictObject({});
export const credentialClearRequestSchema = z.strictObject({ confirm: z.literal(true) });
export const credentialAcknowledgementSchema = z.strictObject({ success: z.literal(true) });
export const credentialErrorCodeSchema = z.enum([
  "CREDENTIAL_UNAUTHORIZED",
  "CREDENTIAL_FORBIDDEN",
  "CREDENTIAL_INVALID_REQUEST",
  "CREDENTIAL_NOT_FOUND",
  "CREDENTIAL_STORAGE_DISABLED",
  "CREDENTIAL_UNAVAILABLE",
]);
export const credentialErrorResponseSchema = z.strictObject({
  code: credentialErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
});
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>;
export type CredentialListResponse = z.infer<typeof credentialListResponseSchema>;
export type CredentialErrorCode = z.infer<typeof credentialErrorCodeSchema>;
