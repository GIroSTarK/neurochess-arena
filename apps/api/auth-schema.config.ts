import { betterAuth } from "better-auth/minimal";

import { authOptions } from "./src/auth/options.js";

// Schema generation does not connect to a database or load deployment secrets.
export const auth = betterAuth(
  authOptions({
    BETTER_AUTH_URL: "https://schema.invalid",
    WEB_ORIGIN: "https://schema.invalid",
    BETTER_AUTH_SECRET: "schema-generation-only-placeholder-not-a-deployment-secret",
  }),
);
