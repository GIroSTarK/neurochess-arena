import { randomBytes } from "node:crypto";

import { expect, it } from "vitest";

import { parseApiEnvironment } from "../env.js";

const base = {
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "test-only-auth-secret-longer-than-32-chars",
  DATABASE_URL: "postgresql://localhost/fixture",
};

it("accepts disabled storage or a complete valid encryption configuration", () => {
  expect(parseApiEnvironment(base).CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
  const configured = {
    CREDENTIAL_ENCRYPTION_KEY_ID: "test-v1",
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  expect(parseApiEnvironment({ ...base, ...configured })).toMatchObject(configured);
});

it("fails closed on incomplete or malformed encryption settings without echoing their values", () => {
  for (const settings of [
    { CREDENTIAL_ENCRYPTION_KEY_ID: "key-id-canary" },
    { CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
    { CREDENTIAL_ENCRYPTION_KEY_ID: "key-id-canary", CREDENTIAL_ENCRYPTION_KEY: "secret-canary" },
    {
      CREDENTIAL_ENCRYPTION_KEY_ID: "bad/id-canary",
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
    {
      CREDENTIAL_ENCRYPTION_KEY_ID: "id-canary\n",
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    },
    {
      CREDENTIAL_ENCRYPTION_KEY_ID: "v1",
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(31).toString("base64"),
    },
    {
      CREDENTIAL_ENCRYPTION_KEY_ID: "v1",
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") + "\n",
    },
  ]) {
    expect(() => parseApiEnvironment({ ...base, ...settings })).toThrow(/CREDENTIAL_ENCRYPTION/);
    try {
      parseApiEnvironment({ ...base, ...settings });
    } catch (error) {
      expect(String(error)).not.toContain("canary");
    }
  }
});
