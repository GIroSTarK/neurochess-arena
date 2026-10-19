import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { applicationDistribution } from "./application-assets.ts";
import { escapeHtml, legalPage } from "./legal-pages.ts";
import { parseSandboxFlag } from "./src/app/env.ts";
import { en } from "./src/i18n/en.ts";
import { stockfishAssets } from "./stockfish-assets.ts";

/** The canvas token also colors the browser chrome; index.html reads it instead of repeating it. */
function canvasColor(): string {
  const stylesheet = readFileSync(new URL("./src/styles.css", import.meta.url), "utf8");
  const token = /--color-canvas:\s*(#[0-9a-fA-F]{6})\s*;/.exec(stylesheet)?.[1];
  if (token === undefined) throw new Error("src/styles.css does not define --color-canvas.");
  return token;
}

// The development and preview servers share the origin the API allows by default.
const localServer = { host: "localhost", port: 5173, strictPort: true };

// Cache vendor libraries separately so application releases do not invalidate them.
const vendorChunks = [
  {
    name: "react",
    test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
  },
  { name: "zod", test: /node_modules[\\/]zod[\\/]/ },
  { name: "i18n", test: /node_modules[\\/](i18next|react-i18next)[\\/]/ },
];

export default defineConfig(({ mode, command }) => ({
  // Validate before injection so a misconfigured value never enters the browser bundle.
  define: {
    // NODE_ENV can make DEV true during a build; fixtures require the dev server itself.
    __ARENA_REFERENCE_ENABLED__: JSON.stringify(command === "serve"),
    "import.meta.env.SANDBOX_ENABLED": JSON.stringify(
      parseSandboxFlag(
        loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "SANDBOX_ENABLED")
          .SANDBOX_ENABLED,
      ),
    ),
  },
  build: {
    license: { fileName: "THIRD-PARTY-NOTICES.md" },
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        privacy: fileURLToPath(new URL("./privacy.html", import.meta.url)),
        terms: fileURLToPath(new URL("./terms.html", import.meta.url)),
      },
      output: {
        postBanner:
          "/* Neurochess Arena: GPL-3.0-only. License, matching source and third-party notices: /licensing.html */",
        codeSplitting: { groups: vendorChunks },
      },
    },
  },
  clearScreen: false,
  envDir: "../..",
  plugins: [
    applicationDistribution(),
    stockfishAssets(),
    react(),
    tailwindcss(),
    {
      name: "document-metadata",
      transformIndexHtml: {
        order: "pre",
        handler: (html, context) => {
          const page = /[/\\](privacy|terms)\.html$/.exec(context.filename)?.[1];
          const legal = page === "privacy" || page === "terms" ? legalPage(page) : null;
          return html
            .replace("%NC_TITLE%", escapeHtml(legal?.title ?? en.app.title))
            .replace("%NC_DESCRIPTION%", escapeHtml(legal?.description ?? en.app.description))
            .replace("%NC_THEME_COLOR%", canvasColor())
            .replace("%NC_LEGAL_BODY%", legal?.body ?? "")
            .replace(
              "%NC_NO_SCRIPT%",
              `<main><h1>${escapeHtml(en.app.title)}</h1><p>${escapeHtml(en.app.description)}</p><p>${escapeHtml(en.legal.noScript)}</p><nav aria-label="${escapeHtml(en.legal.navigation)}"><a href="/privacy.html">${escapeHtml(en.legal.privacy)}</a> · <a href="/terms.html">${escapeHtml(en.legal.terms)}</a> · <a href="/licensing.html">${escapeHtml(en.licensing.link)}</a></nav></main>`,
            );
        },
      },
    },
  ],
  preview: localServer,
  server: localServer,
}));
