import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const packages = new Set();
function inspectModules(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const names = entry.name.startsWith("@")
      ? readdirSync(join(directory, entry.name)).map((name) => `${entry.name}/${name}`)
      : [entry.name];
    for (const name of names) {
      packages.add(name);
      inspectModules(join(directory, name, "node_modules"));
    }
  }
}

inspectModules("/app/node_modules");
for (const workspace of ["apps/api", "packages/chess", "packages/contracts", "packages/database"]) {
  inspectModules(`/app/${workspace}/node_modules`);
}

const developmentPackages = [
  "auth",
  "concurrently",
  "dependency-cruiser",
  "drizzle-kit",
  "esbuild",
  "eslint",
  "jsdom",
  "playwright",
  "prettier",
  "react",
  "react-dom",
  "stockfish",
  "tailwindcss",
  "tsx",
  "typescript",
  "vite",
  "vitest",
];
const unexpected = [...packages].filter(
  (name) =>
    developmentPackages.includes(name) ||
    /^@(esbuild|esbuild-kit|playwright|tailwindcss|testing-library|typescript|vitest)\//.test(
      name,
    ) ||
    ["@neurochess/config", "@neurochess/web"].includes(name),
);
assert.deepEqual(unexpected.sort(), [], "Development/browser packages leaked into the API image");

for (const path of ["/app/.env", "/app/apps/api/test", "/app/test"]) {
  assert.equal(existsSync(path), false, `Unexpected production runtime artifact: ${path}`);
}
for (const name of [
  "@neurochess/chess",
  "@neurochess/contracts",
  "@neurochess/database",
  "better-auth/minimal",
  "fastify",
  "nodemailer",
  "pg",
  "ws",
  "zod",
]) {
  await import(name);
}
await import("/app/apps/api/dist/app.js");
await import("/app/apps/api/dist/auth/service.js");
process.stdout.write(`API runtime dependency check passed (${packages.size} package names).\n`);
