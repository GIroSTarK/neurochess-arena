import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("saved credential label interpolation", () => {
  it.each(["Arena key", "$t(" + "a".repeat(60), "$t(app.name)", "$& $$ $' $`"])(
    "preserves the literal label %s",
    (label) => {
      // A process deadline also bounds synchronous regexp stalls in older i18next versions.
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { createWebI18n } from './apps/web/src/i18n/index.ts';
           process.stdout.write(JSON.stringify(createWebI18n().t('credentials.revokeLabel', {
             label: ${JSON.stringify(label)}
           })));`,
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 16_384,
        },
      );
      expect(JSON.parse(output)).toBe(`Revoke key: ${label}`);
    },
    10_000,
  );
});
