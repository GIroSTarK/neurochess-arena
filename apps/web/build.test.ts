import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import type { Rolldown } from "vite";
import { afterEach, expect, it, vi } from "vitest";

import { buildWeb } from "./build";

afterEach(() => vi.unstubAllEnvs());

it.each(["development", "test"])(
  "keeps a production web build within budget when API NODE_ENV is %s",
  async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    vi.stubEnv("SANDBOX_ENABLED", "false");
    const output = (await buildWeb({
      root: fileURLToPath(new URL(".", import.meta.url)),
      configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
      mode: "production",
      logLevel: "silent",
      build: { write: false },
    })) as Rolldown.RolldownOutput;
    const application = output.output.filter(
      (item) => item.type === "chunk" || item.fileName.endsWith(".css"),
    );
    expect(application.length).toBeGreaterThan(0);
    const gzipBytes = application.reduce(
      (sum, item) => sum + gzipSync(item.type === "chunk" ? item.code : item.source).length,
      0,
    );
    expect(gzipBytes).toBeLessThanOrEqual(300 * 1024);
  },
  15_000,
);
