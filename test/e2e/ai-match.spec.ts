import { text as streamText } from "node:stream/consumers";

import AxeBuilder from "@axe-core/playwright";
import { type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";
import type { Page, Request } from "@playwright/test";

import { observeCredentialPrivacy } from "./credential-privacy";
import { API_ORIGIN } from "./environment";
import { expect, submitGame, test } from "./fixtures";
import { expectSelectArrowSpacing } from "./select-controls";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

async function configure(page: Page, color: "White" | "Black", key: string) {
  const seat = page.getByRole("group", { name: color, exact: true });
  await expect(seat.getByLabel("Provider", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await seat
    .getByLabel("Provider", { exact: true })
    .selectOption(color === "White" ? "openai" : "anthropic");
  await seat.getByLabel("API key", { exact: true }).fill(key);
  await seat.getByRole("button", { name: "Load models", exact: true }).click();
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
}
async function start(page: Page, white = "match-fixture", black = "match-fixture") {
  await page.goto("/");
  await configure(page, "White", white);
  await configure(page, "Black", black);
  const { details } = await submitGame(page);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  return details.snapshot;
}
async function read(page: Page, gameId: string) {
  const response = await page.request.get(`${API_ORIGIN}/games/${gameId}`);
  expect(response.status()).toBe(200);
  return gameSnapshotSchema.parse(await response.json());
}
async function fillRecovery(page: Page) {
  const reenter = page.getByRole("button", { name: "Re-enter your API keys", exact: true });
  if (await reenter.isVisible()) await reenter.click();
  await page.getByLabel("White · OpenAI · API key", { exact: true }).fill("match-fixture");
  await page.getByLabel("Black · Anthropic · API key", { exact: true }).fill("match-fixture");
}
async function stop(page: Page) {
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop game", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
}

test("public Arena completes a match, exposes private replay and PGN, and keeps the previous URL", async ({
  page,
  newContext,
}, testInfo) => {
  const game = await start(page);
  const url = page.url();
  await page.getByLabel("Delay between moves").selectOption("500");
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
  const final = await read(page, game.gameId);
  expect(final.moves.map(({ uci }) => uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);
  expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "First", exact: true }).click();
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", game.fen);
  await page.getByRole("button", { name: "Last", exact: true }).click();
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", final.fen);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PGN" }).click();
  const stream = await (await download).createReadStream();
  expect(await streamText(stream)).toBe(final.pgn);
  await page.screenshot({ path: testInfo.outputPath("ai-replay.png"), fullPage: true });
  expect(
    await page.evaluate(() => JSON.stringify({ localStorage, sessionStorage, name: window.name })),
  ).not.toContain("match-fixture");
  await page.getByRole("button", { name: "New game", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
  const stranger = await newContext();
  try {
    expect((await stranger.request.get(`${API_ORIGIN}/games/${game.gameId}/replay`)).status()).toBe(
      401,
    );
  } finally {
    await stranger.close();
  }
});

test("Pause, speed, duplicate Next move and Resume use complete server snapshots", async ({
  page,
}, testInfo) => {
  const game = await start(page, "slow-fixture");
  await expectSelectArrowSpacing(page.getByLabel("Delay between moves"));
  await page.getByLabel("Delay between moves").selectOption("5000");
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toHaveAttribute("aria-disabled", "false");
  await pause.focus();
  await pause.press("Enter");
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Re-enter your API keys" })).toHaveCount(0);
  await page.reload();
  await fillRecovery(page);
  const before = await read(page, game.gameId);
  const step = page.getByRole("button", { name: "Next move", exact: true });
  await step.dblclick();
  await expect
    .poll(async () => (await read(page, game.gameId)).moves.length)
    .toBe(before.moves.length + 1);
  const after = await read(page, game.gameId);
  expect(after.state).toBe("paused");
  expect(after.legalMoves).toEqual([]);
  expect(after.version).toBe(before.version + 1);
  expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("ai-paused.png"), fullPage: true });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(async () => (await read(page, game.gameId)).moves.length).toBe(2);
  await stop(page);
  expect((await read(page, game.gameId)).state).toBe("aborted");
});

test("single steps can complete checkmate and every paused position remains read-only", async ({
  page,
}) => {
  const game = await start(page, "slow-fixture");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await page.reload();
  await fillRecovery(page);
  for (let ply = 1; ply <= 4; ply++) {
    const step = page.getByRole("button", { name: "Next move", exact: true });
    await expect(step).toHaveAttribute("aria-disabled", "false");
    await step.click();
    await expect.poll(async () => (await read(page, game.gameId)).moves.length).toBe(ply);
  }
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
});

test("ordinary Pause preserves keys and details without credential replacement controls", async ({
  page,
}, testInfo) => {
  const game = await start(page);
  await page.getByLabel("Delay between moves").selectOption("5000");
  await expect.poll(async () => (await read(page, game.gameId)).moves.length).toBe(1);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  const keys = page.getByRole("region", { name: "Re-enter your API keys" });
  await expect(keys).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await expect(page.getByRole("button", { name: /Change API keys|Hide API keys/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Commentary & move details" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Moves", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ordinary-pause.png"), fullPage: true });
  await page.getByRole("button", { name: "Next move", exact: true }).click();
  await expect.poll(async () => (await read(page, game.gameId)).moves.length).toBe(2);
  await expect(keys).toHaveCount(0);
  await page.getByLabel("Delay between moves").selectOption("500");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
});

test("a provider-rejected key opens only its seat and replacement stays editable until explicit retry", async ({
  page,
}) => {
  const game = await start(page, "expired-fixture");
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  const whiteKey = page.getByLabel("White · OpenAI · API key", { exact: true });
  await expect(whiteKey).toHaveValue("");
  await expect(page.getByLabel("Black · Anthropic · API key", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("The provider rejected this key. Enter a replacement, then retry.", {
      exact: true,
    }),
  ).toBeVisible();
  await whiteKey.pressSequentially("match-fixture");
  await expect(whiteKey).toHaveValue("match-fixture");
  await expect(whiteKey).toBeFocused();
  expect((await read(page, game.gameId)).moves).toHaveLength(0);
  await page.getByRole("button", { name: "Next move", exact: true }).click();
  await expect.poll(async () => (await read(page, game.gameId)).moves.length).toBe(1);
  await expect(page.getByRole("region", { name: "Re-enter your API keys" })).toHaveCount(0);
  await page.getByLabel("Delay between moves").selectOption("500");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
});

test("recovery fields and match controls reflow with expanded text and keyboard focus", async ({
  page,
}, testInfo) => {
  await start(page, "slow-fixture");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Re-enter your API keys" })).toBeVisible();
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectSelectArrowSpacing(page.getByLabel(/^Delay between moves/));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expectUnbrokenWords(page.getByRole("region", { name: /^Game controls/ }));
    const resume = page
      .getByRole("region", { name: /^Game controls/ })
      .getByRole("button", { name: /^Resume/ });
    await resume.focus();
    await expect(resume).toBeFocused();
    const recoveryResume = page.getByRole("button", { name: /^Resume game/ });
    await recoveryResume.scrollIntoViewIfNeeded();
    await expect(recoveryResume).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("ai-expanded.png"), fullPage: true });
  await setPseudoLocalization(page, false);
  await stop(page);
});

test("an uncertain Pause retries the identical command before any continuation", async ({
  page,
}) => {
  const commands: unknown[] = [];
  await page.route("**/lifecycle", async (route) => {
    const command = route.request().postDataJSON() as { action: string };
    if (command.action !== "pause") {
      await route.continue();
      return;
    }
    commands.push(command);
    const response = await route.fetch();
    await route.fulfill(commands.length === 1 ? { json: {} } : { response });
  });
  const game = await start(page, "slow-fixture");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry control", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry control", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect((await read(page, game.gameId)).moves).toEqual([]);
  await stop(page);
});

test("invalid outputs cause a technical loss while provider failures pause for key update and explicit retry", async ({
  page,
}) => {
  const invalid = await start(page, "invalid-fixture");
  await expect(page.getByRole("heading", { name: /technical loss/i })).toBeVisible();
  expect((await read(page, invalid.gameId)).terminationReason).toBe("model_technical_loss");
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  const events = page.getByRole("tabpanel", { name: "Events", exact: true });
  await expect(events.getByText("Invalid responses: 3 of 3", { exact: true })).toBeVisible();
  await expect(events.getByText("Attempt 3 · Invalid response", { exact: true })).toBeVisible();
  await expect(events.getByText(/Attempt 4/)).toHaveCount(0);
  await page.getByRole("button", { name: "New game", exact: true }).click();
  await configure(page, "White", "quota-fixture");
  await configure(page, "Black", "match-fixture");
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  await expect(
    page.getByText(/White · The provider reported a quota/, { exact: false }).first(),
  ).toBeVisible();
  await page.reload();
  await fillRecovery(page);
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible({
    timeout: 15_000,
  });
});

for (const during of ["inference", "delay"] as const) {
  test(`refresh during ${during} recovers full configuration and requires both keys plus explicit action`, async ({
    page,
  }, testInfo) => {
    const keys = [
      during === "inference" ? "slow-fixture" : "refresh-white-fixture-sentinel",
      "refresh-black-fixture-sentinel",
    ] as const;
    const expectPrivate = observeCredentialPrivacy(page, [...keys, "match-fixture"]);
    const turnsWithOriginalKey: boolean[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/ai-turn")) {
        turnsWithOriginalKey.push(keys.some((key) => request.postData()?.includes(key)));
      }
    });
    const game = await start(page, ...keys);
    if (during === "delay") {
      await page.getByLabel("Delay between moves").selectOption("5000");
      await expect.poll(async () => (await read(page, game.gameId)).moves.length).toBe(1);
    }
    await expect.poll(() => turnsWithOriginalKey).toEqual([true]);
    await expectPrivate();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    const count = turnsWithOriginalKey.length;
    expect(count).toBe(1);
    await expectPrivate();
    const recovered = await read(page, game.gameId);
    expect(recovered.state).toBe("paused");
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(page.getByLabel("White · OpenAI · API key", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Black · Anthropic · API key", { exact: true })).toHaveValue("");
    const recovery = page.getByRole("region", { name: "Re-enter your API keys" });
    await expect(recovery).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Commentary & move details" })).toHaveCount(0);
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", recovered.fen);
    await page.screenshot({
      path: testInfo.outputPath(`key-recovery-${during}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Return to game", exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Moves", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Re-enter your API keys", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByText("Re-enter the missing API keys before continuing.", { exact: true }),
    ).toBeVisible();
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    await expect(resume).toHaveAttribute("aria-disabled", "true");
    await resume.focus();
    await resume.press("Enter");
    expect(turnsWithOriginalKey).toHaveLength(count);
    await fillRecovery(page);
    expect(turnsWithOriginalKey).toHaveLength(count);
    await expectPrivate();
    await expect(recovery).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual(
      [],
    );
    await page.getByLabel("Delay between moves").selectOption("5000");
    await page
      .getByRole("button", { name: during === "delay" ? "Resume game" : "Next move", exact: true })
      .click();
    await expect
      .poll(async () => (await read(page, game.gameId)).moves.length)
      .toBe(recovered.moves.length + 1);
    expect(turnsWithOriginalKey.slice(count)).toEqual([false]);
    await expectPrivate();
    await stop(page);
  });
}

test(
  "a competing tab fences the old controller and an absent tab pauses between calls",
  { tag: "@controller-protocol" },
  async ({ page, context }) => {
    const game = await start(page);
    await page.getByLabel("Delay between moves").selectOption("5000");
    await expect.poll(async () => (await read(page, game.gameId)).moves.length).toBe(1);
    const other = await context.newPage();
    try {
      await other.goto(page.url());
      await expect(other.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
      await page.bringToFront();
      await expect(page.getByText(/This tab lost control/).first()).toBeVisible();
      await other.bringToFront();
      await fillRecovery(other);
      await other.getByLabel("Delay between moves").selectOption("5000");
      await other.getByRole("button", { name: "Resume", exact: true }).click();
      await expect.poll(async () => (await read(other, game.gameId)).moves.length).toBe(2);
      await other.close();
      await expect
        .poll(async () => (await read(page, game.gameId)).state, { timeout: 20_000 })
        .toBe("paused");
      expect((await read(page, game.gameId)).moves).toHaveLength(2);
    } finally {
      if (!other.isClosed()) await other.close();
    }
  },
);

test("lost turn acknowledgement blocks automatic dispatch until explicit synchronization", async ({
  page,
}) => {
  let calls = 0;
  let committed: GameSnapshot | undefined;
  await page.route("**/ai-turn", async (route) => {
    calls++;
    const response = await route.fetch();
    committed = gameSnapshotSchema.parse(await response.json());
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const game = await start(page);
  await expect(page.getByRole("button", { name: "Synchronize and pause" })).toBeVisible();
  expect(calls).toBe(1);
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", game.fen);
  await page.getByRole("button", { name: "Synchronize and pause" }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  expect((await read(page, game.gameId)).moves).toEqual(committed?.moves);
  expect(calls).toBe(1);
  await page.unroute("**/ai-turn");
  await stop(page);
});

test(
  "network loss between calls expires presence without a snapshot read performing recovery",
  { tag: "@controller-protocol" },
  async ({ page }) => {
    await page.route("**/controller", async (route) => {
      const body = route.request().postDataJSON() as { action: string };
      if (body.action === "heartbeat") await route.fulfill({ json: {} });
      else await route.continue();
    });
    const game = await start(page);
    await page.getByLabel("Delay between moves").selectOption("5000");
    await expect(page.getByRole("button", { name: "Synchronize and pause" })).toBeVisible();
    await expect
      .poll(async () => (await read(page, game.gameId)).state, { timeout: 20_000 })
      .toBe("paused");
    expect((await read(page, game.gameId)).moves).toHaveLength(1);
  },
);

test("closing the controlling tab during inference pauses without accepting its late move", async ({
  page,
  context,
}) => {
  const game = await start(page, "slow-fixture");
  await expect
    .poll(async () => {
      const records = await page.request.get(`${API_ORIGIN}/games/${game.gameId}/invocations`);
      const payload = (await records.json()) as { turns: { attempts: unknown[] }[] };
      return payload.turns[0]?.attempts.length;
    })
    .toBe(1);
  await page.close();
  const state = async () =>
    gameSnapshotSchema.parse(
      await (await context.request.get(`${API_ORIGIN}/games/${game.gameId}`)).json(),
    );
  await expect.poll(async () => (await state()).state, { timeout: 20_000 }).toBe("paused");
  expect((await state()).moves).toEqual([]);
});

test("Stop remains usable during inference and late acknowledgements cannot revive the game", async ({
  page,
}) => {
  const released = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<Request>();
  let turnRequests = 0;
  const countTurn = (request: Request) => {
    if (request.method() === "POST" && request.url().endsWith("/ai-turn")) turnRequests++;
  };
  page.on("request", countTurn);
  await page.clock.install();
  await page.route("**/ai-turn", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    entered.resolve(route.request());
    await released.promise;
    await route.fulfill({ response });
  });
  try {
    const game = await start(page);
    await page.getByLabel("Delay between moves").selectOption("500");
    const request = await entered.promise;
    expect(turnRequests).toBe(1);
    await stop(page);
    released.resolve();
    await page.unrouteAll({ behavior: "wait" });
    const response = await request.response();
    if (response) {
      expect(await response.finished()).toBeNull();
    } else {
      expect(request.failure()?.errorText).toMatch(
        /^(?:net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/,
      );
    }

    // Let response handling and a full playback delay elapse before checking the client.
    await page.clock.runFor(1_000);
    await expect(page.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New game", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download PGN", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Pause|Resume|Next move|Stop)$/ })).toHaveCount(
      0,
    );
    expect(turnRequests).toBe(1);
    const final = await read(page, game.gameId);
    expect(final.state).toBe("aborted");
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", final.fen);
  } finally {
    released.resolve();
    await page.unrouteAll({ behavior: "wait" });
    page.off("request", countTurn);
  }
});
