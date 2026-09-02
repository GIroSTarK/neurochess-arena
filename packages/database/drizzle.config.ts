import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

import { parseDatabaseUrl } from "./src/database-url.js";

try {
  loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch (error: unknown) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

export default defineConfig({
  dbCredentials: {
    url: parseDatabaseUrl(process.env.DATABASE_URL),
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema/index.ts",
  strict: true,
  verbose: true,
});
