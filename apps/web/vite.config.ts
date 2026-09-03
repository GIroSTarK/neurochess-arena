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

export default defineConfig({
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
