import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { en } from "./src/i18n/en.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Vendor libraries change on their own schedule. Each ships as its own cacheable chunk, so a
// release of the application code does not invalidate them, and no chunk nears the size warning.
const vendorChunks = [
  {
    name: "react",
    test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
  },
  { name: "zod", test: /node_modules[\\/]zod[\\/]/ },
  { name: "i18n", test: /node_modules[\\/](i18next|react-i18next)[\\/]/ },
];

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: { groups: vendorChunks },
      },
    },
  },
  clearScreen: false,
  envDir: "../..",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "localized-document-metadata",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html
            .replace("%NC_TITLE%", escapeHtml(en.app.title))
            .replace("%NC_DESCRIPTION%", escapeHtml(en.app.description)),
      },
    },
  ],
  preview: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});
