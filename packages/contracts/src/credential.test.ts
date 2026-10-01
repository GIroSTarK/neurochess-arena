import { expect, it } from "vitest";

import { credentialMetadataSchema, credentialSaveRequestSchema } from "./credential.js";

const input = {
  credentialId: "b52fef4e-6a8f-4d47-9d9c-0cde5717efcc",
  save: true,
  provider: "openai",
  label: "Personal",
  apiKey: "fixture-key-1234",
};

it("requires explicit saving, bounded fields and no caller-supplied owner or ciphertext", () => {
  expect(credentialSaveRequestSchema.parse(input)).toEqual(input);
  for (const changes of [
    { save: undefined },
    { save: false },
    { userId: input.credentialId },
    { ciphertext: "secret" },
    { provider: "unknown" },
    { credentialId: "bad" },
    { label: "" },
    { label: "x".repeat(65) },
    { label: "bad\nlabel" },
    { label: input.apiKey },
    { label: `My ${input.apiKey} key` },
    { apiKey: "" },
    { apiKey: "x".repeat(4097) },
    { apiKey: "secret\n" },
  ]) {
    expect(credentialSaveRequestSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  }
});

it("metadata cannot carry plaintext, encryption material, owner or arbitrary suffixes", () => {
  const metadata = {
    credentialId: input.credentialId,
    provider: "openai",
    label: "Personal",
    maskedSuffix: "1234",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  expect(credentialMetadataSchema.parse(metadata)).toEqual(metadata);
  for (const changes of [
    { apiKey: input.apiKey },
    { userId: input.credentialId },
    { ciphertext: "secret" },
    { nonce: "secret" },
    { maskedSuffix: "<x/>" },
    { maskedSuffix: input.apiKey },
  ]) {
    expect(credentialMetadataSchema.safeParse({ ...metadata, ...changes }).success).toBe(false);
  }
  expect(credentialMetadataSchema.safeParse({ ...metadata, maskedSuffix: null }).success).toBe(
    true,
  );
});
