import { describe, expect, it } from "vitest";

import { parseApiEnvironment } from "../env.js";

const base = {
  NODE_ENV: "test",
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "oauth-environment-fixture-secret-only",
  DATABASE_URL: "postgresql://localhost/neurochess",
};

describe("OAuth environment", () => {
  it.each(["GOOGLE", "GITHUB"])(
    "validates the complete %s credential pair without printing secrets",
    (provider) => {
      const id = `${provider}_CLIENT_ID`;
      const secret = `${provider}_CLIENT_SECRET`;
      expect(parseApiEnvironment(base)[id as "GOOGLE_CLIENT_ID"]).toBeUndefined();
      expect(
        parseApiEnvironment({ ...base, [id]: "fixture-id", [secret]: "secret-canary" }),
      ).toMatchObject({
        [id]: "fixture-id",
        [secret]: "secret-canary",
      });
      for (const pair of [
        { [id]: "fixture-id" },
        { [secret]: "secret-canary" },
        { [id]: " ", [secret]: "secret-canary" },
        { [id]: "fixture-id", [secret]: "secret-canary\r\ninjected" },
        { [id]: "fixture-id", [secret]: "" },
      ]) {
        expect(() => parseApiEnvironment({ ...base, ...pair })).toThrow(`${provider}_CLIENT_`);
        try {
          parseApiEnvironment({ ...base, ...pair });
        } catch (error) {
          expect((error as Error).message).not.toContain("secret-canary");
        }
      }
    },
  );
});
