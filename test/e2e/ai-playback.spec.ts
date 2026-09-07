import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import {
  aiTurnRequestSchema,
  gameSnapshotSchema,
  lifecycleCommandSchema,
} from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { expect, readSnapshot, test } from "./fixtures";

async function start(page: Page, whiteKey = "fixture-playback") {
  await page.goto("/");
  await expect(page).toHaveTitle("Set up a match · Neurochess Arena");
  for (const color of ["White", "Black"]) {
    const panel = page.getByRole("region", { name: `${color} configuration` });
    const provider = panel.getByRole("combobox", { name: "Provider" });
    await expect(provider).toHaveAttribute("aria-disabled", "false");
    await provider.selectOption(color === "White" ? "openai" : "anthropic");
    await panel
      .getByLabel("API key", { exact: true })
      .fill(color === "White" ? whiteKey : "fixture-playback");
    await panel.getByRole("button", { name: "Load models" }).click();
    const picker = panel.getByRole("combobox", { name: "Model", exact: true });
    await picker.fill("Fixture full");
    await picker.press("ArrowDown");
    await picker.press("Enter");
  }
  const created = page.waitForResponse((response) => response.url() === API_ORIGIN + "/ai/games");
  await page.getByRole("button", { name: "Start game" }).click();
  const initial = gameSnapshotSchema.parse(await (await created).json());
  await expect(page).toHaveTitle("AI vs AI · Neurochess Arena");
  await expect(page.getByRole("heading", { name: "AI vs AI", exact: true })).toBeVisible();
  await expect(page.locator('[data-seat="white"]')).toContainText("fixture-full");
  await expect(page.locator('[data-seat="black"]')).toContainText("anthropic");
  await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  return initial;
}

test("automatic mixed-provider playback reaches checkmate once and halts at the terminal result", async ({
  page,
}) => {
  const commands: ReturnType<typeof aiTurnRequestSchema.parse>[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) {
      commands.push(aiTurnRequestSchema.parse(request.postDataJSON()));
    }
  });
  const initial = await start(page);
  await page.getByRole("combobox", { name: "Playback speed" }).selectOption("2");
  await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible({
    timeout: 15_000,
  });
  const current = await readSnapshot(page, initial.gameId);
  expect(current.state).toBe("completed");
  expect(current.terminationReason).toBe("checkmate");
  expect(current.moves.map(({ uci }) => uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);
  expect(commands.map(({ expectedVersion }) => expectedVersion)).toEqual([0, 1, 2, 3]);
  expect(commands.map(({ credential }) => credential.provider)).toEqual([
    "openai",
    "anthropic",
    "openai",
    "anthropic",
  ]);
  expect(new Set(commands.map(({ commandId }) => commandId)).size).toBe(4);
  await expect(page.getByRole("group", { name: "AI playback controls" })).toHaveCount(0);
  await page.waitForTimeout(1_100);
  expect(commands).toHaveLength(4);
});

test("pause, a single paused step, resume and stop remain usable during thinking", async ({
  page,
}, info) => {
  let turns = 0;
  let humanMoves = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) turns++;
    if (request.url().endsWith("/moves")) humanMoves++;
  });
  const initial = await start(page);
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toHaveAttribute("aria-disabled", "false");
  await pause.click();
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toHaveAttribute("aria-disabled", "false");
  await expect(resume).toBeFocused();
  const paused = await readSnapshot(page, initial.gameId);
  expect(paused.state).toBe("paused");
  expect(paused.moves).toHaveLength(0);
  const next = page.getByRole("button", { name: "Next move" });
  await next.click();
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await next.press("Enter");
  await expect(next).toHaveAttribute("aria-disabled", "false");
  const stepped = await readSnapshot(page, initial.gameId);
  expect(stepped.state).toBe("paused");
  expect(stepped.moves).toHaveLength(1);
  expect(turns).toBe(2);
  await page.waitForTimeout(1_100);
  expect(turns).toBe(2);
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  expect(humanMoves).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const viewport = page.viewportSize();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport?.width ?? 0,
  );
  await page.screenshot({
    path: join(tmpdir(), `neurochess-ai-playback-${info.project.name}.png`),
    fullPage: true,
  });
  await resume.click();
  await expect.poll(() => turns).toBe(3);
  const stop = page.getByRole("button", { name: "Stop game", exact: true });
  await expect(stop).toHaveAttribute("aria-disabled", "false");
  await stop.click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.getByRole("dialog").getByRole("button", { name: "Stop game" }).click();
  await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
  const stopped = await readSnapshot(page, initial.gameId);
  expect(stopped.state).toBe("aborted");
  expect(stopped.result).toBe("*");
  expect(stopped.moves).toHaveLength(1);
  await page.waitForTimeout(1_100);
  expect(turns).toBe(3);
});

test("the browser accepts a model response after the ordinary ten-second timeout", async ({
  page,
}) => {
  let turns = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) turns++;
  });
  const initial = await start(page, "fixture-playback-slow");
  await page.waitForTimeout(10_200);
  await expect(
    page.getByText("White is choosing a move…", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  expect(turns).toBe(1);
  expect((await readSnapshot(page, initial.gameId)).moves).toHaveLength(0);
  await expect.poll(async () => (await readSnapshot(page, initial.gameId)).moves.length).toBe(1);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next move" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  expect((await readSnapshot(page, initial.gameId)).moves).toHaveLength(1);
});

for (const failedReadBack of [false, true]) {
  test(`recovers an unreserved paused step${failedReadBack ? " after its lifecycle read-back fails" : ""} and permits a fresh step`, async ({
    page,
  }) => {
    const turns: ReturnType<typeof aiTurnRequestSchema.parse>[] = [];
    const controls: ReturnType<typeof lifecycleCommandSchema.parse>[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/ai-turn")) {
        turns.push(aiTurnRequestSchema.parse(request.postDataJSON()));
      }
      if (request.url().endsWith("/lifecycle")) {
        controls.push(lifecycleCommandSchema.parse(request.postDataJSON()));
      }
    });
    const initial = await start(page);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const next = page.getByRole("button", { name: "Next move" });
    await expect(next).toHaveAttribute("aria-disabled", "false");
    const paused = await readSnapshot(page, initial.gameId);
    const beforeStep = turns.length;
    controls.length = 0;
    // Drop this POST before the real API, returning an invalid transport response. All
    // subsequent snapshot/lifecycle calls use the actual service and PostgreSQL state.
    await page.route(
      `${API_ORIGIN}/games/${initial.gameId}/ai-turn`,
      (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
      { times: 1 },
    );
    await next.click();
    // Reconciliation can consume the ordinary ten-second snapshot transport deadline.
    await expect(page.getByText("The turn could not be confirmed.", { exact: false })).toBeVisible({
      timeout: 12_000,
    });
    await expect(next).toHaveAttribute("aria-disabled", "true");
    if (failedReadBack) {
      await page.route(
        `${API_ORIGIN}/games/${initial.gameId}`,
        (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
        { times: 1 },
      );
    }
    const rejectedPause = page.waitForResponse(
      (response) => response.url().endsWith("/lifecycle") && response.status() === 409,
    );
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(await (await rejectedPause).json()).toHaveProperty("code", "INVALID_GAME_STATE");
    if (failedReadBack) {
      const retry = page.getByRole("button", { name: "Retry recovery" });
      await expect(retry).toHaveAttribute("aria-disabled", "false");
      await expect(page.getByRole("button", { name: "Stop game" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await retry.click();
      const pause = page.getByRole("button", { name: "Pause", exact: true });
      await expect(pause).toHaveAttribute("aria-disabled", "false");
      await expect(page.getByRole("button", { name: "Stop game" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
      await expect(next).toHaveAttribute("aria-disabled", "true");
      expect(turns).toHaveLength(beforeStep + 1);
      await pause.click();
    }
    await expect(next).toHaveAttribute("aria-disabled", "false");
    const recovered = await readSnapshot(page, initial.gameId);
    expect(recovered).toMatchObject({
      state: "paused",
      version: paused.version + 2,
      fen: paused.fen,
      moves: paused.moves,
    });
    expect(controls.map(({ action, expectedVersion }) => [action, expectedVersion])).toEqual([
      ...(failedReadBack ? [["pause", paused.version]] : []),
      ["pause", paused.version],
      ["resume", paused.version],
      ["pause", paused.version + 1],
    ]);
    await page.waitForTimeout(1_100);
    expect(turns).toHaveLength(beforeStep + 1);
    await next.click();
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(next).toHaveAttribute("aria-disabled", "false");
    const stepped = await readSnapshot(page, initial.gameId);
    expect(stepped.state).toBe("paused");
    expect(stepped.moves).toHaveLength(paused.moves.length + 1);
    expect(turns.at(-1)?.expectedVersion).toBe(recovered.version);
    expect(turns.at(-1)?.commandId).not.toBe(turns[beforeStep]?.commandId);
  });
}

test("Stop confirmation survives an accepted move and stops the latest revision", async ({
  page,
}, info) => {
  let turns = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) turns++;
  });
  const firstTurn = page.waitForResponse(
    (response) => response.url().endsWith("/ai-turn") && response.status() === 200,
  );
  const initial = await start(page);
  await page.getByRole("combobox", { name: "Playback speed" }).selectOption("0.5");
  await page.getByRole("button", { name: "Stop game" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const confirm = dialog.getByRole("button", { name: "Stop game" });
  await confirm.focus();
  const accepted = gameSnapshotSchema.parse(await (await firstTurn).json());
  expect(accepted.moves).toHaveLength(1);
  await expect.poll(() => turns).toBe(2);
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeFocused();
  await page.screenshot({
    path: join(tmpdir(), `neurochess-stop-confirmation-${info.project.name}.png`),
  });
  const stop = page.waitForResponse((response) => response.url().endsWith("/lifecycle"));
  await confirm.click();
  const response = await stop;
  expect(lifecycleCommandSchema.parse(response.request().postDataJSON())).toMatchObject({
    action: "abort",
    expectedVersion: accepted.version,
  });
  await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
  expect(await readSnapshot(page, initial.gameId)).toMatchObject({
    state: "aborted",
    moves: accepted.moves,
  });
  await page.waitForTimeout(2_100);
  expect(turns).toBe(2);
});

test("routine Pause and Resume preserve Stop and history positions without recovery controls", async ({
  page,
}, info) => {
  const initial = await start(page, "fixture-layout");
  await page.evaluate(() => document.fonts.ready);
  const controls = page.getByRole("group", { name: "AI playback controls" });
  const toggle = controls.getByRole("button").first();
  const stop = page.getByRole("button", { name: "Stop game", exact: true });
  const history = page.getByRole("region", { name: "Moves", exact: true });
  async function positions() {
    return {
      stop: await stop.evaluate((element) => element.getBoundingClientRect().top + window.scrollY),
      history: await history.evaluate(
        (element) => element.getBoundingClientRect().top + window.scrollY,
      ),
    };
  }
  for (const action of ["pause", "resume"] as const) {
    const before = await positions();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Delay delivery of the real lifecycle response to inspect the pending presentation.
    await page.route(
      `${API_ORIGIN}/games/${initial.gameId}/lifecycle`,
      async (route) => {
        const response = await route.fetch();
        entered.resolve();
        await release.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    try {
      await toggle.click();
      await entered.promise;
      await expect(toggle).toHaveAttribute("aria-disabled", "true");
      await expect(toggle).toBeFocused();
      await expect(page.getByRole("button", { name: "Retry recovery" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry same command" })).toHaveCount(0);
      await expect(
        controls
          .getByText("Applying your game control…", { exact: true })
          .filter({ visible: true }),
      ).toBeVisible();
      const during = await positions();
      expect(Math.abs(during.stop - before.stop)).toBeLessThan(1);
      expect(Math.abs(during.history - before.history)).toBeLessThan(1);
      await page.screenshot({
        path: join(tmpdir(), `neurochess-${action}-pending-${info.project.name}.png`),
        fullPage: true,
      });
    } finally {
      release.resolve();
    }
    await expect(toggle).toHaveAttribute("aria-disabled", "false");
    await expect(toggle).toBeFocused();
    const after = await positions();
    expect(Math.abs(after.stop - before.stop)).toBeLessThan(1);
    expect(Math.abs(after.history - before.history)).toBeLessThan(1);
    await expect(page.getByRole("button", { name: "Retry recovery" })).toHaveCount(0);
  }
  await stop.click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop game" }).click();
  await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
});
