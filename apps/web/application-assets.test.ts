import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { applicationSourceFiles } from "./application-assets";

it("packages build sources without local secrets, dependency trees or test fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "neurochess-licensing-test-"));
  if (dirname(root) !== tmpdir()) throw new Error("Unexpected temporary source directory");
  try {
    const included = [
      "apps/web/src/main.tsx",
      "apps/web/build.ts",
      "apps/api/src/server.ts",
      "packages/contracts/src/index.ts",
      "packages/config/tsconfig/base.json",
      "packages/database/drizzle/meta/_journal.json",
    ];
    const excluded = [
      "apps/web/.env",
      "apps/api/.env.production",
      "apps/api/src/credentials.json",
      "apps/api/src/private.key",
      "apps/web/dist/assets/app.js",
      "apps/web/node_modules/vendor/index.js",
      "apps/web/src/test/setup.ts",
      "apps/web/src/game.test.tsx",
      "packages/contracts/test-fixtures/private.ts",
    ];
    for (const path of [...included, ...excluded]) {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "source-archive-private-file-canary");
    }
    const names = applicationSourceFiles(root);
    for (const name of included) expect(names).toContain(name);
    for (const name of excluded) expect(names).not.toContain(name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
