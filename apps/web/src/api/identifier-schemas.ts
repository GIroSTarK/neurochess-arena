import { authSessionResponseSchema, credentialRevokeRequestSchema } from "@neurochess/contracts";

export const accountIdSchema = authSessionResponseSchema.unwrap().shape.user.shape.id;
export const credentialIdSchema = credentialRevokeRequestSchema.shape.credentialId;
