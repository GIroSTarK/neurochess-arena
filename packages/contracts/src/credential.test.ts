import { describe, expect, it } from "vitest";

import {
  credentialClearRequestSchema,
  credentialListQuerySchema,
  credentialMetadataSchema,
  credentialSaveRequestSchema,
} from "./credential.js";

const credentialId = "4a8fef5d-8911-414d-89e6-847b5a2d1c29";

const request = {
  save: true,
  provider: "openai",
  label: "  Personal key  ",
  apiKey: "test-only-secret-Ab12",
};

describe("saved credential contracts", () => {
  it("requires explicit saving, bounds keys and labels, and rejects authority or encryption fields", () => {
    expect(credentialSaveRequestSchema.parse(request).label).toBe("Personal key");
    for (const patch of [
      { save: undefined },
      { save: false },
      { provider: "other" },
      { apiKey: "" },
      { apiKey: "x".repeat(4097) },
      { apiKey: "test\nsecret" },
      { label: " " },
      { label: "x".repeat(65) },
      { label: "<script>" },
      { label: "line\nbreak" },
      { label: "hidden\u202Etext" },
      { label: request.apiKey },
      { label: `prefix ${request.apiKey}` },
      { userId: credentialId },
      { credentialId },
      { ciphertext: "value" },
      { keyId: "value" },
    ]) {
      expect(credentialSaveRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
    expect(
      credentialSaveRequestSchema.safeParse({ ...request, label: "Особистий ключ" }).success,
    ).toBe(true);
    expect(credentialClearRequestSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(credentialClearRequestSchema.safeParse({}).success).toBe(false);
    expect(credentialClearRequestSchema.safeParse({ confirm: false }).success).toBe(false);
  });

  it("accepts only safe metadata and a bounded account-independent cursor", () => {
    const metadata = {
      credentialId,
      provider: "google",
      label: "Personal key",
      maskedSuffix: "Ab12",
      createdAt: new Date().toISOString(),
    };
    expect(credentialMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(credentialMetadataSchema.safeParse({ ...metadata, maskedSuffix: null }).success).toBe(
      true,
    );
    for (const patch of [
      { maskedSuffix: "long-key" },
      { maskedSuffix: "<>\n!" },
      { apiKey: request.apiKey },
      { ciphertext: "secret" },
      { userId: credentialId },
    ]) {
      expect(credentialMetadataSchema.safeParse({ ...metadata, ...patch }).success).toBe(false);
    }
    expect(credentialListQuerySchema.parse({ after: metadata.credentialId })).toEqual({
      after: metadata.credentialId,
    });
    for (const query of [{ after: "invalid" }, { userId: credentialId }, { limit: "99999" }]) {
      expect(credentialListQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
