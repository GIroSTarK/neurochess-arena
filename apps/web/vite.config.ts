import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  envDir: "../..",
  plugins: [react()],
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
