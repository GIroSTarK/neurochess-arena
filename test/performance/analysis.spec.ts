import { readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { createGame } from "@neurochess/chess";
import { aiControllerRequestSchema, gameSnapshotSchema } from "@neurochess/contracts";
import { type Page, test as assetFailureTest } from "@playwright/test";

import { createAccount } from "../e2e/account-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "../e2e/environment";
import { expect, playMove, readSnapshot, submitGame, test } from "../e2e/fixtures";
import { createRoom, joinRoom } from "../e2e/room-helpers";

import { instrument, visibility, workerProbe } from "./probes";

async function humanGame(page: Page) {
  await page.getByLabel("Game mode").selectOption("ai_vs_human");
  await page.getByLabel("Your color").selectOption("white");
  const seat = page.getByRole("group", { name: "Black", exact: true });
  await seat.getByLabel("Provider", { exact: true }).selectOption("openai");
  await seat.getByLabel("API key", { exact: true }).fill("match-fixture");
  await seat.getByRole("button", { name: "Load models", exact: true }).click();
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
  return submitGame(page);
}

test("production entry, engine resources and repeated game lifetimes stay bounded", async ({
  page,
  browser,
}, info) => {
  await instrument(page);
  const requested = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === WEB_ORIGIN) requested.add(url.pathname);
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up a game", exact: true })).toBeVisible();
  expect([...requested].filter((path) => path.includes("/engines/"))).toEqual([]);
  const directory = process.env.PERFORMANCE_BUILD_DIRECTORY!;
  const entryAssets = await Promise.all(
    [...requested]
      .filter((path) => /\.(js|css)$/.test(path))
      .map(async (path) => {
        const bytes = await readFile(join(directory, path));
        return { path, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
      }),
  );
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  expect([...requested].filter((path) => path.includes("/engines/"))).toEqual([]);
  await page.getByRole("link", { name: "Arena", exact: true }).click();
  const { details } = await humanGame(page);
  await expect(page.getByTestId("evaluation-score")).toBeVisible({ timeout: 20_000 });
  const probe = await workerProbe(browser);
  const heap = await probe.heap();
  await probe.startCpu();
  const before = await readSnapshot(page, details.snapshot.gameId);
  const moveStart = performance.now();
  await playMove(page, before, "f2f3", info.project.name === "mobile-touch");
  const moveThroughUiMs = performance.now() - moveStart;
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await expect(page.getByTestId("evaluation-score")).toBeVisible();
  // Observe several bounded searches and their mandatory idle intervals.
  await page.waitForTimeout(4000);
  const cpu = await probe.stopCpu();
  const afterHeap = await probe.heap();
  await probe.close();
  const metrics = await page.evaluate(() => window.arenaMeasurements);
  const engineAssets = await Promise.all(
    ["js", "wasm"].map(async (extension) => {
      const bytes = await readFile(
        join(directory, "engines/sf19-lite-single-v2", `stockfish-19-lite-single.${extension}`),
      );
      return { extension, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
    }),
  );
  const workerResources = await page.workers()[0]!.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => {
      const resource = entry as PerformanceResourceTiming;
      return {
        file: new URL(resource.name).pathname.split("/").at(-1),
        transferBytes: resource.transferSize,
        encodedBytes: resource.encodedBodySize,
        durationMs: resource.duration,
      };
    }),
  );
  const report = {
    profile: {
      browser: browser.version(),
      viewport: page.viewportSize(),
      touchEmulation: info.project.name === "mobile-touch",
      platform: platform(),
      os: release(),
      cpu: cpus()[0]!.model,
      logicalCpus: cpus().length,
      hostMemoryBytes: totalmem(),
      throttling: "none; localhost static production build",
    },
    entryAssets,
    entryGzipBytes: entryAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    engine: {
      assets: engineAssets,
      resources: workerResources,
      startupMs: metrics.startupMs,
      heap,
      afterHeap,
      cpu,
    },
    moveThroughUiMs,
    mutationToPaintMs: metrics.paints,
    workers: { peak: metrics.peak, created: metrics.created },
  };
  await writeFile(info.outputPath("measurements.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  expect(report.entryGzipBytes).toBeLessThanOrEqual(300 * 1024);
  expect(entryAssets.reduce((sum, asset) => sum + asset.bytes, 0)).toBeLessThanOrEqual(1024 * 1024);
  expect(engineAssets.reduce((sum, asset) => sum + asset.bytes, 0)).toBeLessThanOrEqual(
    2 * 1024 * 1024,
  );
  expect(metrics.startupMs).toHaveLength(1);
  expect(metrics.startupMs[0]).toBeLessThanOrEqual(2000);
  expect(Math.max(heap.usedSize, afterHeap.usedSize)).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(moveThroughUiMs).toBeLessThanOrEqual(1000);
  expect(metrics.paints.length).toBeGreaterThan(0);
  expect(Math.max(...metrics.paints)).toBeLessThanOrEqual(100);
  expect(cpu.activeRatio).toBeLessThanOrEqual(0.9);
  expect(metrics.searches.filter((search) => search.end === null)).toHaveLength(0);
  for (let index = 1; index < metrics.searches.length; index++) {
    expect(
      metrics.searches[index]!.start - metrics.searches[index - 1]!.end!,
    ).toBeGreaterThanOrEqual(240);
  }
  expect(metrics.peak).toBe(1);
  for (let cycle = 0; cycle < 3; cycle++) {
    await visibility(page, "hidden");
    await expect.poll(() => page.workers().length).toBe(0);
    const searches = await page.evaluate(() => window.arenaMeasurements.searches.length);
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => window.arenaMeasurements.searches.length)).toBe(searches);
    await visibility(page, "visible");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/auth\/sign-in/);
    await expect.poll(() => page.workers().length).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/games/${details.snapshot.gameId}$`));
    await expect(page.getByTestId("evaluation-score")).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => window.arenaMeasurements.peak)).toBe(1);
  }
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect.poll(() => page.workers().length).toBe(0);
  const lifetimes = await page.evaluate(() => ({
    created: window.arenaMeasurements.created,
    live: window.arenaMeasurements.live,
    peak: window.arenaMeasurements.peak,
  }));
  expect(lifetimes.created).toBeGreaterThanOrEqual(4);
  expect(lifetimes.created).toBeLessThanOrEqual(7);
  expect(lifetimes.live).toBe(0);
  expect(lifetimes.peak).toBe(1);
  await writeFile(info.outputPath("lifetimes.json"), JSON.stringify(lifetimes));
  await createAccount(page.request);
  requested.clear();
  await page.goto("/account");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await page.goto("/account/credentials");
  await expect(page.getByLabel("Label", { exact: true })).toBeVisible();
  expect([...requested].filter((path) => path.includes("/engines/"))).toEqual([]);
  expect(page.workers()).toHaveLength(0);
});

function longHistory() {
  for (let seed = 1; seed <= 30; seed++) {
    const game = createGame();
    game.start();
    let random = seed;
    for (let ply = 0; ply < 200 && game.snapshot().state === "active"; ply++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const legal = game.snapshot().legalMoves;
      game.playMove(legal[random % legal.length]!);
    }
    if (game.snapshot().moves.length === 200 && game.snapshot().state === "active") {
      return game.snapshot().moves.map((move) => move.uci);
    }
  }
  throw new Error("Could not construct the deterministic long-history fixture");
}

test("worker WASM memory stays within the measured allocation budget", async ({
  page,
  context,
}, info) => {
  // A separate memory run observes exported memories; timing/CPU runs use untouched engine assets.
  await context.route("**/stockfish-19-lite-single.js", async (route) => {
    const response = await route.fetch();
    const observer = `{
      const instantiate = WebAssembly.instantiateStreaming;
      WebAssembly.instantiateStreaming = async function(...args) {
        const result = await Reflect.apply(instantiate, WebAssembly, args);
        const memories = Object.values(result.instance.exports).filter(value => value instanceof WebAssembly.Memory);
        globalThis.arenaWasmMemoryBytes = () => memories.map(memory => memory.buffer.byteLength);
        return result;
      };
    }\n`;
    await route.fulfill({ response, body: observer + (await response.text()) });
  });
  await page.goto("/");
  const { details } = await humanGame(page);
  await expect(page.getByTestId("evaluation-score")).toBeVisible({ timeout: 20_000 });
  const memory = () =>
    page
      .workers()[0]!
      .evaluate(() =>
        (globalThis as unknown as { arenaWasmMemoryBytes: () => number[] }).arenaWasmMemoryBytes(),
      );
  const initial = await memory();
  await playMove(page, details.snapshot, "f2f3", info.project.name === "mobile-touch");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await expect(page.getByTestId("evaluation-score")).toBeVisible();
  const afterMoves = await memory();
  const report = {
    wasmLinearMemoryBytes: { initial, afterMoves },
    scope: "Exported WASM memory; excludes JS heap and browser overhead",
  };
  await writeFile(info.outputPath("wasm-memory.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  expect(initial).toHaveLength(1);
  expect(afterMoves).toHaveLength(1);
  expect(Math.max(...initial, ...afterMoves)).toBeLessThanOrEqual(160 * 1024 * 1024);
});

// The upstream WASM loader reports a console/error event on deliberate rejection.
// Use the base fixture for these faults; the server still owns all disposable identities.
for (const extension of ["js", "wasm"]) {
  assetFailureTest(
    `delayed then failed ${extension} loading preserves moves, replay and explicit analysis recovery`,
    async ({ page, context }, info) => {
      await instrument(page);
      // Engine loading can begin before the controller grants permission to move.
      await context.route("**/controller", async (route) => {
        const command = aiControllerRequestSchema.parse(route.request().postDataJSON());
        if (command.action === "acquire") {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        await route.continue();
      });
      const release = Promise.withResolvers<void>();
      let attempted = 0;
      const pattern = `**/stockfish-19-lite-single.${extension}`;
      await context.route(pattern, async (route) => {
        attempted++;
        await release.promise;
        await route.abort();
      });
      try {
        await page.goto("/");
        const { details } = await humanGame(page);
        await expect.poll(() => attempted).toBe(1);
        await expect(page.getByTestId("evaluation-score")).toHaveCount(0);
        await playMove(page, details.snapshot, "f2f3", info.project.name === "mobile-touch");
        await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
        release.resolve();
        const retry = page.getByRole("button", { name: "Retry analysis", exact: true });
        await expect(retry).toBeVisible({ timeout: 20_000 });
        await playMove(
          page,
          await readSnapshot(page, details.snapshot.gameId),
          "g2g4",
          info.project.name === "mobile-touch",
        );
        await expect(
          page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "First", exact: true }).click();
        await expect(page.getByRole("grid")).toHaveAttribute("data-fen", details.snapshot.fen);
        expect(attempted).toBe(1);
        await context.unroute(pattern);
        await retry.click();
        await expect(page.getByTestId("evaluation-score")).toBeVisible({ timeout: 20_000 });
        expect(await page.evaluate(() => window.arenaMeasurements.peak)).toBe(1);
        await page.getByRole("link", { name: "Arena", exact: true }).click();
        await expect.poll(() => page.workers().length).toBe(0);
      } finally {
        release.resolve();
        await context.unroute(pattern);
      }
    },
  );
}

test("200-ply private replay remains responsive while real analysis backfills", async ({
  page,
  newContext,
  browser,
}, info) => {
  await instrument(page);
  const { invitation, gameId } = await createRoom(page, "White");
  const peer = await (await newContext()).newPage();
  await joinRoom(peer, invitation, gameId);
  await page.getByRole("link", { name: "Arena", exact: true }).click();
  await peer.getByRole("link", { name: "Arena", exact: true }).click();
  let snapshot = await readSnapshot(page, gameId);
  for (const move of longHistory()) {
    const request = snapshot.turn === "white" ? page.request : peer.request;
    const response = await request.post(`${API_ORIGIN}/games/${gameId}/moves`, {
      headers: { origin: WEB_ORIGIN },
      data: { gameId, move, expectedVersion: snapshot.version, commandId: crypto.randomUUID() },
    });
    expect(response.status()).toBe(200);
    snapshot = gameSnapshotSchema.parse(await response.json());
  }
  const aborted = await page.request.post(`${API_ORIGIN}/games/${gameId}/lifecycle`, {
    headers: { origin: WEB_ORIGIN },
    data: {
      gameId,
      action: "abort",
      expectedVersion: snapshot.version,
      commandId: crypto.randomUUID(),
    },
  });
  expect(aborted.status()).toBe(200);
  const opened = performance.now();
  await page.goto(`/games/${gameId}`);
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", snapshot.fen);
  const openReplayMs = performance.now() - opened;
  await expect(page.getByTestId("evaluation-score")).toBeVisible({ timeout: 20_000 });
  const probe = await workerProbe(browser);
  await probe.startCpu();
  const selections: number[] = [];
  const position = page.getByLabel("Replay position", { exact: true });
  for (const ply of [1, 199, 50, 150, 25, 175, 75, 125, 100, 0]) {
    await position.scrollIntoViewIfNeeded();
    const duration = await position.evaluate(async (element, ply) => {
      const before = performance.now();
      const painted = new Promise<number>((resolve) => {
        const observer = new MutationObserver(() => {
          const marker = document.querySelector('[data-testid="evaluation-marker"]');
          if (marker?.getAttribute("data-ply") !== String(ply)) return;
          observer.disconnect();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(performance.now() - before)),
          );
        });
        observer.observe(document, {
          attributes: true,
          subtree: true,
          attributeFilter: ["data-ply"],
        });
      });
      const input = element as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        String(ply),
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return painted;
    }, ply);
    selections.push(duration);
  }
  await page.waitForTimeout(4000);
  const heap = await probe.heap();
  const cpu = await probe.stopCpu();
  await probe.close();
  const report = {
    browser: browser.version(),
    viewport: page.viewportSize(),
    plies: 200,
    openReplayMs,
    selectionToPaintMs: selections,
    heap,
    cpu,
    workers: await page.evaluate(() => ({
      live: window.arenaMeasurements.live,
      peak: window.arenaMeasurements.peak,
      searches: window.arenaMeasurements.searches.length,
    })),
  };
  await writeFile(info.outputPath("long-replay.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  expect(report.workers.peak).toBe(1);
  expect(openReplayMs).toBeLessThanOrEqual(2000);
  expect(Math.max(...selections)).toBeLessThanOrEqual(200);
  expect(heap.usedSize).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(cpu.activeRatio).toBeLessThanOrEqual(0.9);
  await visibility(page, "hidden");
  await expect.poll(() => page.workers().length).toBe(0);
  const dispatched = await page.evaluate(() => window.arenaMeasurements.searches.length);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.arenaMeasurements.searches.length)).toBe(dispatched);
  await visibility(page, "visible");
  await expect.poll(() => page.workers().length).toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.arenaMeasurements.searches.length))
    .toBeGreaterThan(dispatched);
  expect(await page.evaluate(() => window.arenaMeasurements.peak)).toBe(1);
  await page.getByRole("link", { name: "Arena", exact: true }).click();
  await expect.poll(() => page.workers().length).toBe(0);
});
