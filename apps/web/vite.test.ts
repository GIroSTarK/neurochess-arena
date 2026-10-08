import { fileURLToPath } from "node:url";

import { build } from "vite";
import { describe, expect, it, vi } from "vitest";

async function productionChunks(sandboxEnabled: boolean, nodeEnv: "production" | "development") {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("SANDBOX_ENABLED", String(sandboxEnabled));
  vi.stubEnv("VITE_API_BASE_URL", "http://localhost:3001");
  const result = await build({
    root: fileURLToPath(new URL(".", import.meta.url)),
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    mode: "production",
    logLevel: "silent",
    build: { write: false },
  });
  if (Array.isArray(result) || !("output" in result)) {
    throw new Error("Expected a single web build");
  }
  return result.output.filter((item) => item.type === "chunk");
}

const sandboxModules = /\/apps\/web\/src\/(sandbox\/|api\/sandbox-client\.ts$)/;

describe.each(["production", "development"] as const)(
  "production bundles with NODE_ENV=%s",
  (nodeEnv) => {
    it("excludes disabled Sandbox and reference fixtures while retaining startup validation", async () => {
      const chunks = await productionChunks(false, nodeEnv);
      const modules = chunks.flatMap((chunk) => chunk.moduleIds);
      expect(modules.filter((id) => sandboxModules.test(id))).toEqual([]);
      expect(modules.filter((id) => id.includes("/apps/web/src/reference/"))).toEqual([]);
      expect(modules.filter((id) => id.includes("/test/e2e/"))).toEqual([]);
      expect(
        modules.filter((id) => /\/apps\/web\/src\/(setup|arena\/setup)\//.test(id)),
      ).not.toEqual([]);
      expect(modules.some((id) => id.endsWith("/app/env.ts"))).toBe(true);
      expect(modules.some((id) => id.endsWith("/api/http.ts"))).toBe(true);
      expect(modules.some((id) => id.endsWith("/api/game-validation.ts"))).toBe(true);
      expect(modules.some((id) => id.endsWith("/gameplay/archive.ts"))).toBe(true);
      expect(modules.some((id) => id.includes("/node_modules/zod/"))).toBe(true);
    });

    it("loads enabled Sandbox through a separate dynamic entry without reference fixtures", async () => {
      const chunks = await productionChunks(true, nodeEnv);
      expect(
        chunks.flatMap((chunk) => chunk.moduleIds).filter((id) => id.includes("/test/e2e/")),
      ).toEqual([]);
      expect(
        chunks
          .flatMap((chunk) => chunk.moduleIds)
          .filter((id) => id.includes("/apps/web/src/reference/")),
      ).toEqual([]);
      const entry = chunks.find((chunk) => chunk.isEntry)!;
      expect(
        chunks
          .flatMap((chunk) => chunk.moduleIds)
          .filter((id) => /\/apps\/web\/src\/(setup|arena\/setup)\//.test(id)),
      ).not.toEqual([]);
      const sandbox = chunks.find((chunk) =>
        chunk.facadeModuleId?.endsWith("/sandbox/sandbox-route.tsx"),
      )!;
      expect(sandbox).toBeDefined();
      expect(sandbox.isDynamicEntry).toBe(true);
      expect(entry.dynamicImports).toContain(sandbox.fileName);

      const eagerChunks = new Set([entry.fileName]);
      for (const fileName of eagerChunks) {
        const chunk = chunks.find((item) => item.fileName === fileName)!;
        for (const dependency of chunk.imports) eagerChunks.add(dependency);
      }
      const eagerModules = chunks
        .filter((chunk) => eagerChunks.has(chunk.fileName))
        .flatMap((chunk) => chunk.moduleIds);
      expect(eagerModules.filter((id) => sandboxModules.test(id))).toEqual([]);
      expect(eagerModules.some((id) => id.endsWith("/gameplay/archive.ts"))).toBe(true);
      for (const path of [
        "/sandbox/route-data.ts",
        "/sandbox/controller.ts",
        "/sandbox/recovery.ts",
        "/api/sandbox-client.ts",
        "/board/chessboard.tsx",
      ]) {
        expect(chunks.some((chunk) => chunk.moduleIds.some((id) => id.endsWith(path)))).toBe(true);
      }
    });
  },
);
