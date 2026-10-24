import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { build, preview, type PreviewServer } from "vite";

import type * as Probe from "./analysis-entry";

let server: PreviewServer | undefined;
let directory: string;
let origin: string;
const base = "/analysis-smoke/";
const probePath = `${base}analysis-probe.js`;
const enginePath = `${base}engines/sf19-lite-single-v2/`;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "neurochess-analysis-build-"));
  const config = {
    root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
    configFile: fileURLToPath(new URL("../../apps/web/vite.config.ts", import.meta.url)),
    base,
    logLevel: "silent" as const,
    build: {
      outDir: directory,
      rolldownOptions: {
        preserveEntrySignatures: "strict" as const,
        input: {
          app: fileURLToPath(new URL("../../apps/web/index.html", import.meta.url)),
          "analysis-probe": fileURLToPath(new URL("./analysis-entry.ts", import.meta.url)),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  };
  await build(config);
  server = await preview({ ...config, preview: { host: "localhost", port: 0, strictPort: false } });
  origin = server.resolvedUrls!.local[0]!.replace(/\/analysis-smoke\/$/, "");
});

test.afterAll(async () => {
  const active = server;
  if (active) {
    await new Promise<void>((resolve, reject) =>
      active.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (
    directory &&
    dirname(directory) === tmpdir() &&
    basename(directory).startsWith("neurochess-analysis-build-")
  ) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production deep links load the real engine lazily with correct MIME types and notices", async ({
  page,
  request,
}) => {
  const engineRequests: string[] = [];
  page.on("request", (event) => {
    if (event.url().includes(enginePath)) engineRequests.push(event.url());
  });
  await page.goto(`${origin}${base}games/f0cfe67b-38a0-4e83-aec4-96c81ef479b7`);
  expect(engineRequests).toEqual([]);
  const result = await page.evaluate(async (path) => {
    const probe = (await import(path)) as typeof Probe;
    try {
      return await probe.analyze([]);
    } finally {
      probe.dispose();
    }
  }, probePath);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("Real engine did not return a score");
  expect(result.sample.depth).toBeGreaterThanOrEqual(0);
  expect(result.sample.depth).toBeLessThanOrEqual(18);
  expect(["cp", "mate"]).toContain(result.sample.score.kind);
  expect(result.sample.durationMs).toBeLessThanOrEqual(3000);
  expect(engineRequests.filter((url) => url.endsWith(".js"))).toHaveLength(1);
  expect(engineRequests.filter((url) => url.endsWith(".wasm"))).toHaveLength(1);
  const wasm = await request.get(`${origin}${enginePath}stockfish-19-lite-single.wasm`);
  expect(wasm.headers()["content-type"]).toContain("application/wasm");
  const js = await request.get(`${origin}${enginePath}stockfish-19-lite-single.js`);
  expect(js.headers()["content-type"]).toMatch(/javascript/);
  await page.goto(`${origin}${enginePath}index.html`);
  await expect(page.getByRole("link", { name: "Exact corresponding source" })).toHaveAttribute(
    "href",
    "stockfish-source.tar.gz",
  );
  const manifest = await request.get(`${origin}${enginePath}manifest.json`);
  expect(((await manifest.json()) as { profileId: string }).profileId).toBe("sf19-lite-single-v2");
});

test("real no-move completion reports verified checkmate without inventing a score from a result", async ({
  page,
}) => {
  await page.goto(`${origin}${base}`);
  const result = await page.evaluate(async (path) => {
    const probe = (await import(path)) as typeof Probe;
    try {
      return await probe.analyze(["f2f3", "e7e5", "g2g4", "d8h4"]);
    } finally {
      probe.dispose();
    }
  }, probePath);
  expect(result).toMatchObject({
    status: "ready",
    sample: { ply: 4, depth: 0, score: { kind: "mate", winner: "black", moves: 0 } },
  });
});

for (const extension of ["js", "wasm"]) {
  test(`failed packaged ${extension} fetch stays unavailable until explicit analysis Retry`, async ({
    page,
    context,
  }) => {
    let loads = 0;
    const pattern = `**/stockfish-19-lite-single.${extension}`;
    await context.route(pattern, (route) => {
      loads++;
      return route.abort();
    });
    await page.goto(`${origin}${base}games/f0cfe67b-38a0-4e83-aec4-96c81ef479b7`);
    const result = await page.evaluate(async (path) => {
      const probe = (await import(path)) as typeof Probe;
      return [await probe.analyze([]), await probe.analyze([])];
    }, probePath);
    expect(result).toEqual([
      {
        status: "unavailable",
        reason: extension === "wasm" ? "initialization_timeout" : "engine_load_failed",
        fatal: true,
      },
      {
        status: "unavailable",
        reason: extension === "wasm" ? "initialization_timeout" : "engine_load_failed",
        fatal: true,
      },
    ]);
    expect(loads).toBe(1);
    await context.unroute(pattern);
    const recovered = await page.evaluate(async (path) => {
      const probe = (await import(path)) as typeof Probe;
      probe.retry();
      try {
        return await probe.analyze([]);
      } finally {
        probe.dispose();
      }
    }, probePath);
    expect(recovered.status).toBe("ready");
  });
}
