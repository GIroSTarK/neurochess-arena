import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { applicationDistribution } from "./application-assets.ts";
import { parseSandboxFlag } from "./src/app/env.ts";
import { en } from "./src/i18n/en.ts";
import { stockfishAssets } from "./stockfish-assets.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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
        handler: (html) =>
          html
            .replace("%NC_TITLE%", escapeHtml(en.app.title))
            .replace("%NC_DESCRIPTION%", escapeHtml(en.app.description))
            .replace("%NC_THEME_COLOR%", canvasColor()),
      },
    },
  ],
  preview: localServer,
  server: localServer,
}));
