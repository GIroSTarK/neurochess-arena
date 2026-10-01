import { randomBytes, randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { createCredentialCipher } from "./crypto.js";

const context = { userId: randomUUID(), credentialId: randomUUID(), provider: "openai" as const };
const key = randomBytes(32).toString("base64");
const options = { keyId: "fixture-v1", key };
const plaintext = "fixture-provider-secret-canary-1234";

it("encrypts with distinct random nonces and authenticates before releasing plaintext", () => {
  const cipher = createCredentialCipher(options);
  const a = cipher.encrypt(context, plaintext);
  const b = cipher.encrypt(context, plaintext);
  expect(a.nonce).not.toBe(b.nonce);
  expect(a.ciphertext).not.toBe(b.ciphertext);
  expect(JSON.stringify(a)).not.toContain(plaintext);
  expect(cipher.decrypt(context, a)).toBe(plaintext);
  expect(createCredentialCipher(options).decrypt(context, b)).toBe(plaintext);
});

it("rejects wrong key, authenticated owner/provider/record context and every tampered field safely", () => {
  const cipher = createCredentialCipher(options);
  const encrypted = cipher.encrypt(context, plaintext);
  const fail = (call: () => unknown) => {
    expect(call).toThrow("CREDENTIAL_UNAVAILABLE");
    try {
      call();
    } catch (error) {
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toMatch(/canary|fixture-v1/);
    }
  };
  fail(() =>
    createCredentialCipher({ ...options, key: randomBytes(32).toString("base64") }).decrypt(
      context,
      encrypted,
    ),
  );
  for (const changes of [
    { userId: randomUUID() },
    { credentialId: randomUUID() },
    { provider: "google" },
  ]) {
    fail(() => cipher.decrypt({ ...context, ...changes }, encrypted));
  }
  for (const field of ["ciphertext", "nonce", "authTag"] as const) {
    fail(() =>
      cipher.decrypt(context, {
        ...encrypted,
        [field]: (encrypted[field].startsWith("a") ? "b" : "a") + encrypted[field].slice(1),
      }),
    );
  }
  for (const changes of [
    { version: 2 },
    { keyId: "unknown" },
    { nonce: "00" },
    { authTag: "00" },
    { ciphertext: "a" },
    { ciphertext: "gg" },
    { ciphertext: "" },
    { ciphertext: "aa".repeat(4097) },
    { extra: plaintext },
  ]) {
    fail(() => cipher.decrypt(context, { ...encrypted, ...changes }));
  }
});

it("does not accept invalid keys, contexts or plaintext via the server-only primitive", () => {
  for (const key of [
    "bad-secret-canary",
    randomBytes(31).toString("base64"),
    randomBytes(33).toString("base64"),
    options.key + "\n",
  ]) {
    expect(() => createCredentialCipher({ ...options, key })).toThrow(
      "CREDENTIAL_CONFIGURATION_INVALID",
    );
  }
  const cipher = createCredentialCipher(options);
  expect(() => cipher.encrypt({ ...context, userId: "forged" }, plaintext)).toThrow(
    "CREDENTIAL_UNAVAILABLE",
  );
  expect(() => cipher.encrypt(context, "key\n")).toThrow("CREDENTIAL_UNAVAILABLE");
});

it("uses canonical UUID context across PostgreSQL's normalization of uppercase IDs", () => {
  const cipher = createCredentialCipher(options);
  const uppercase = {
    ...context,
    userId: context.userId.toUpperCase(),
    credentialId: context.credentialId.toUpperCase(),
  };
  expect(cipher.decrypt(context, cipher.encrypt(uppercase, plaintext))).toBe(plaintext);
});
