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
    const secret = "build-private-environment-canary";
    for (const name of [
      "BETTER_AUTH_SECRET",
      "CREDENTIAL_ENCRYPTION_KEY",
      "DATABASE_URL",
      "GOOGLE_CLIENT_SECRET",
      "GITHUB_CLIENT_SECRET",
      "SMTP_PASSWORD",
    ]) {
      vi.stubEnv(name, secret);
    }
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
    for (const item of output.output) {
      const content = item.type === "chunk" ? item.code : Buffer.from(item.source).toString();
      expect(content).not.toContain(secret);
      if (item.type === "chunk") {
        expect(Object.keys(item.modules).join("\n")).not.toMatch(
          /\/src\/(?:sandbox|arena-reference)\/|\/test\/|setup-providers/,
        );
      }
    }
    const notices = output.output.find((item) => item.fileName === "THIRD-PARTY-NOTICES.md");
    expect(notices?.type).toBe("asset");
    if (notices?.type !== "asset") throw new Error("Missing bundled dependency notices");
    const licenseText = Buffer.from(notices.source).toString();
    for (const dependency of ["react", "react-dom", "react-router", "i18next", "zod", "chess.js"]) {
      expect(licenseText).toContain(dependency);
    }
    expect(licenseText).toContain("Permission is hereby granted");
    expect(licenseText).toContain("The Inter Project Authors");
    expect(licenseText).toContain("The Orbitron Project Authors");
    expect(licenseText).toContain("SIL OPEN FONT LICENSE Version 1.1");
  },
  15_000,
);
