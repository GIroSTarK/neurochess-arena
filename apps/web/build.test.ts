import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
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
    const asset = (name: string) => {
      const item = output.output.find((entry) => entry.fileName === name);
      expect(item?.type, name).toBe("asset");
      if (item?.type !== "asset") throw new Error(`Missing distribution asset: ${name}`);
      return Buffer.from(item.source);
    };
    const upstreamSources = asset("THIRD_PARTY_NOTICES.md")
      .toString()
      .split("## Upstream JavaScript sources")[1]
      ?.split(/\r?\n## /)[0];
    const sourcePackages = [...(upstreamSources ?? "").matchAll(/^\| ([^|]+)\|/gm)].flatMap(
      ([, packages]) => [...packages!.matchAll(/((?:@[\w.-]+\/)?[\w.-]+)@([^\s,|]+)/g)],
    );
    expect(
      sourcePackages.map(([, name]) => name),
      "distributed upstream-source inventory includes direct and transitive packages",
    ).toEqual(
      expect.arrayContaining([
        "react",
        "react-dom",
        "scheduler",
        "use-sync-external-store",
        "react-router",
        "i18next",
        "react-i18next",
        "zod",
        "chess.js",
      ]),
    );
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const lockfile = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    const require = createRequire(new URL("./package.json", import.meta.url));
    for (const entry of sourcePackages) {
      const name = entry[1]!;
      const version = entry[2]!;
      const packagePath = require.resolve(`${name}/package.json`);
      const installed = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
      const lockPath = relative(repository, packagePath)
        .replaceAll("\\", "/")
        .replace(/\/package\.json$/, "");
      expect(installed.version, `${name}: installed version matches the lockfile`).toBe(
        lockfile.packages[lockPath]?.version,
      );
      expect(
        version,
        `${name}: matches distributed upstream-source package versions to the selected dependency versions`,
      ).toBe(installed.version);
    }
    expect(asset("LICENSE.txt").toString()).toContain("GNU GENERAL PUBLIC LICENSE");
    const licensing = asset("licensing.html").toString();
    expect(licensing).toContain('href="neurochess-arena-source.tar.gz"');
    expect(licensing).toContain('href="LICENSE.txt"');
    expect(licensing).toContain('href="THIRD-PARTY-NOTICES.md"');
    expect(licensing).toContain('href="THIRD_PARTY_NOTICES.md"');
    for (const [file, title] of [
      ["privacy.html", "Privacy Policy"],
      ["terms.html", "Terms of Service"],
    ] as const) {
      const legal = asset(file).toString();
      expect(legal).toContain(`<title>${title} · Neurochess Arena</title>`);
      expect(legal).toContain('href="mailto:support@neurochess-arena.com"');
      expect(legal).toContain('href="/privacy.html"');
      expect(legal).toContain('href="/terms.html"');
      expect(legal).toMatch(/<h1[^>]*>/);
      expect(legal).toMatch(/<h2[^>]*>/);
      expect(legal).toMatch(/<link[^>]*href="\/assets\/[^"]+\.css"/);
      expect(legal).not.toMatch(/<script|%NC_|id="root"/);
    }
    expect(asset("privacy.html").toString()).toContain("Google sign-in");
    expect(asset("terms.html").toString()).toContain("Provider charges");
    const home = asset("index.html").toString();
    expect(home).toContain('href="/privacy.html"');
    expect(home).toContain('href="/terms.html"');
    expect(home).not.toContain("%NC_");
    const archive = asset("neurochess-arena-source.tar.gz");
    const names = execFileSync("tar", ["-tzf", "-"], { input: archive, encoding: "utf8" });
    expect(names).toContain("apps/web/src/shell/app-shell.tsx");
    expect(names).toContain("apps/web/vite.config.ts");
    expect(names).toContain("apps/web/legal-pages.ts");
    expect(names).toContain("apps/web/src/i18n/legal-en.ts");
    expect(names).toContain("apps/web/privacy.html");
    expect(names).toContain("apps/web/terms.html");
    expect(names).toContain("packages/config/tsconfig/react.json");
    expect(names).toContain("package-lock.json");
    expect(names).toContain("apps/web/vendor/stockfish/build-package-lock.json");
    expect(names).toContain("docs/licensing.md");
    expect(names).not.toMatch(/(?:^|\/)(?:node_modules|dist|\.git|\.env)(?:\/|\r?$)/m);
    const source = execFileSync("tar", ["-xOzf", "-", "apps/web/src/shell/app-shell.tsx"], {
      input: archive,
    });
    expect(source).toEqual(readFileSync(new URL("./src/shell/app-shell.tsx", import.meta.url)));
  },
  15_000,
);
