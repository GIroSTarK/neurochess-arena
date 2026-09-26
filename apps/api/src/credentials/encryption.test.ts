import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createCredentialCipher } from "./encryption.js";

const key = Buffer.alloc(32, 17).toString("base64");
const nextKey = Buffer.alloc(32, 23).toString("base64");
const config = { activeKeyId: "first", keys: { first: key } };
const context = {
  credentialId: randomUUID(),
  userId: "owner-fixture",
  provider: "openai" as const,
};
const plaintext = "test-only-provider-credential-Ab12";

describe("authenticated provider credential encryption", () => {
  it("round trips bounded keys with independent nonces and no plaintext in the envelope", () => {
    const cipher = createCredentialCipher(config);
    const first = cipher.encrypt(context, plaintext);
    const second = cipher.encrypt(context, plaintext);
    expect(cipher.decrypt(context, first)).toBe(plaintext);
    expect(first).toMatchObject({ version: 1, keyId: "first" });
    expect(first.nonce).toHaveLength(24);
    expect(first.authTag).toHaveLength(32);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain(plaintext);
    for (const value of ["x", "x".repeat(4096)]) {
      expect(cipher.decrypt(context, cipher.encrypt(context, value))).toBe(value);
    }
  });

  it("authenticates owner, provider, record, version, key ID and every encrypted field", () => {
    const cipher = createCredentialCipher({
      activeKeyId: "first",
      keys: { first: key, alias: key },
    });
    const envelope = cipher.encrypt(context, plaintext);
    const reject = (operation: () => unknown) => {
      try {
        operation();
        expect.fail("Unauthenticated credential accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("CREDENTIAL_ENCRYPTION_FAILED");
        expect(error).not.toHaveProperty("cause");
        expect(JSON.stringify(error)).not.toContain(plaintext);
      }
    };
    for (const patch of [
      { userId: "another-owner" },
      { provider: "google" as const },
      { credentialId: randomUUID() },
    ]) {
      reject(() => cipher.decrypt({ ...context, ...patch }, envelope));
    }
    for (const field of ["nonce", "authTag", "ciphertext"] as const) {
      const changed = (envelope[field].startsWith("0") ? "1" : "0") + envelope[field].slice(1);
      reject(() => cipher.decrypt(context, { ...envelope, [field]: changed }));
    }
    for (const patch of [
      { version: 2 },
      { keyId: "missing" },
      { keyId: "alias" },
      { nonce: "bad" },
      { authTag: "00".repeat(12) },
      { ciphertext: "x".repeat(64) },
      { ciphertext: "" },
      { ciphertext: "aa".repeat(4097) },
      { nonce: "AA" + envelope.nonce.slice(2) },
      { plaintext },
      { authTag: null },
    ]) {
      reject(() => cipher.decrypt(context, { ...envelope, ...patch }));
    }
    reject(() => cipher.decrypt(context, null));
    reject(() =>
      createCredentialCipher({ activeKeyId: "first", keys: { first: nextKey } }).decrypt(
        context,
        envelope,
      ),
    );
    reject(() => cipher.encrypt(context, "bad\nkey"));
  });

  it("writes with the active key while retaining explicitly configured old decryption keys", () => {
    const old = createCredentialCipher(config).encrypt(context, plaintext);
    const rotated = createCredentialCipher({
      activeKeyId: "second",
      keys: { first: key, second: nextKey },
    });
    expect(rotated.decrypt(context, old)).toBe(plaintext);
    expect(rotated.encrypt(context, plaintext).keyId).toBe("second");
    expect(() =>
      createCredentialCipher({ activeKeyId: "second", keys: { second: nextKey } }).decrypt(
        context,
        old,
      ),
    ).toThrow("CREDENTIAL_ENCRYPTION_FAILED");
  });
});
