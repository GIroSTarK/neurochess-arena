import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import { en } from "./src/i18n/en.ts";
import manifest from "./vendor/stockfish/manifest.json" with { type: "json" };

const repository = fileURLToPath(new URL("../../", import.meta.url));
const rootFiles = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".env.example",
  ".nvmrc",
];
const excludedDirectories = new Set([
  "node_modules",
  "dist",
  "test",
  "test-fixtures",
  "coverage",
  "certificates",
]);
const sourceExtension = /\.(?:ts|tsx|js|mjs|cjs|css|html|sql)$/;

export function applicationSourceFiles(root = repository): string[] {
  const files = [...rootFiles];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || excludedDirectories.has(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Application source cannot contain symlinks");
      if (entry.isDirectory()) visit(path);
      else if (
        !/\.test\.[^.]+$/.test(entry.name) &&
        (sourceExtension.test(entry.name) ||
          entry.name === "package.json" ||
          entry.name === "tsconfig.json" ||
          (path.startsWith("packages/config/tsconfig/") && entry.name.endsWith(".json")) ||
          (path.startsWith("packages/database/drizzle/meta/") && entry.name.endsWith(".json")))
      ) {
        files.push(path);
      }
    }
  };
  for (const directory of ["apps", "packages"]) visit(directory);
  // The distribution includes only build inputs and public documentation. In particular,
  // do not archive the checkout wholesale: local environments and operations data live there.
  for (const [name, file] of Object.entries(manifest.files)) {
    if (file.origin === "vendored") {
      files.push(`apps/web/vendor/stockfish/${name}`);
    }
  }
  files.push(
    "apps/web/vendor/stockfish/manifest.json",
    "apps/web/vendor/stockfish/REBUILD.md",
    "apps/web/vendor/stockfish/SOURCE-NOTICES.txt",
    "docs/licensing.md",
    "docs/development.md",
  );
  return [...new Set(files)].sort();
}

function applicationAssets(bundled: boolean) {
  const archive = execFileSync("tar", ["-czf", "-", "--null", "-T", "-"], {
    cwd: repository,
    input: applicationSourceFiles().join("\0") + "\0",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const copy = en.licensing;
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${copy.title}</title></head>
<body>
<h1>${copy.title}</h1>
<p>Copyright (C) 2026 Illya Katynskyi</p>
<p>${copy.terms}</p>
<p>${copy.warranty}</p>
<ul>
<li><a href="LICENSE.txt">${copy.license}</a></li>
<li><a href="neurochess-arena-source.tar.gz" download>${copy.source}</a></li>
${bundled ? `<li><a href="THIRD-PARTY-NOTICES.md">${copy.dependencies}</a></li>` : ""}
<li><a href="THIRD_PARTY_NOTICES.md">${copy.thirdParty}</a></li>
<li><a href="engines/${manifest.profileId}/index.html">${copy.engine}</a></li>
<li><a href="https://github.com/GIroSTarK/neurochess-arena">${copy.repository}</a></li>
</ul>
</body>
</html>
`;
  return [
    { fileName: "LICENSE.txt", source: readFileSync(join(repository, "LICENSE")) },
    {
      fileName: "THIRD_PARTY_NOTICES.md",
      source: readFileSync(join(repository, "THIRD_PARTY_NOTICES.md")),
    },
    { fileName: "licensing.html", source: Buffer.from(html) },
    { fileName: "neurochess-arena-source.tar.gz", source: archive },
  ];
}

export function applicationDistribution(): Plugin {
  return {
    name: "application-distribution",
    generateBundle() {
      for (const asset of applicationAssets(true)) this.emitFile({ type: "asset", ...asset });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = (request.url ?? "").split("?")[0]?.slice(server.config.base.length);
        if (
          ![
            "LICENSE.txt",
            "THIRD_PARTY_NOTICES.md",
            "licensing.html",
            "neurochess-arena-source.tar.gz",
          ].includes(name ?? "")
        ) {
          next();
          return;
        }
        const asset = applicationAssets(false).find((item) => item.fileName === name);
        if (!asset) {
          next();
          return;
        }
        response.setHeader(
          "Content-Type",
          name === "licensing.html"
            ? "text/html; charset=utf-8"
            : name?.endsWith(".gz")
              ? "application/gzip"
              : "text/plain; charset=utf-8",
        );
        response.end(asset.source);
      });
    },
  };
}
