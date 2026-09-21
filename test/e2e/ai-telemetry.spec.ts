import AxeBuilder from "@axe-core/playwright";
import { gameInvocationsSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { expect, square, test } from "./fixtures";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

async function start(page: Page, key: string, human?: "white" | "black") {
  await page.goto("/");
  if (human) {
    await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
    await page.getByLabel("Game mode").selectOption("ai_vs_human");
    await page.getByLabel("Your color").selectOption(human);
  }
  for (const color of human ? [human === "white" ? "Black" : "White"] : ["White", "Black"]) {
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
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  await expect(page).toHaveURL(/\?game=/);
  return new URL(page.url()).searchParams.get("game")!;
}

for (const human of [undefined, "white", "black"] as const) {
  test(`details keep their anchors from the first move through refresh and pause (${human ?? "AI vs AI"})`, async ({
    page,
  }) => {
    let releaseTurn: (() => void) | undefined;
    await page.route("**/ai-turn", async (route) => {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      await route.continue();
    });
    const longCommentary = "Controls the center while keeping the king safe. ".repeat(30);
    let long = false;
    let hold = false;
    let releaseRecords: (() => void) | undefined;
    await page.route("**/invocations", async (route) => {
      const response = await route.fetch();
      const records = gameInvocationsSchema.parse(await response.json());
      if (hold) {
        await new Promise<void>((resolve) => {
          releaseRecords = resolve;
        });
      }
      await route.fulfill({
        response,
        json: {
          ...records,
          turns: records.turns.map((turn) => ({
            ...turn,
            attempts: turn.attempts.map((attempt) => ({
              ...attempt,
              commentary:
                attempt.outcome === "accepted"
                  ? long
                    ? longCommentary
                    : "Controls the center."
                  : attempt.commentary,
            })),
          })),
        },
      });
    });
    await start(page, "telemetry-fixture", human);
    await page.getByLabel("Delay between moves").selectOption("5000");
    await page.evaluate(() => document.fonts.ready);
    const rail = page.getByRole("complementary", { name: "Game details" });
    const commentary = page.getByRole("region", { name: "Commentary & move details" });
    const geometry = () =>
      rail.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        return [
          element.querySelector('[role="tablist"]')!.getBoundingClientRect().top - top,
          ...[...element.querySelectorAll("article")].flatMap((card) => {
            const rect = card.getBoundingClientRect();
            return [
              rect.top - top,
              rect.height,
              card.querySelector("dl")!.getBoundingClientRect().top - top,
            ];
          }),
        ];
      });
    const before = await geometry();
    if (human === "white") {
      await square(page, "f2").click();
      await square(page, "f3").click();
    }
    await expect.poll(() => Boolean(releaseTurn)).toBe(true);
    hold = true;
    releaseTurn!();
    const move = human === "white" ? "Black · 1. e5" : "White · 1. f3";
    await expect(commentary.getByRole("heading", { name: move, exact: true })).toBeVisible();
    await expect(commentary.getByText("Loading move details…", { exact: true })).toBeVisible();
    expect(await geometry()).toEqual(before);
    await expect.poll(() => Boolean(releaseRecords)).toBe(true);
    hold = false;
    releaseRecords!();
    await expect(commentary.getByText("Controls the center.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    await expect(rail.getByText("Game paused", { exact: true })).toHaveCount(0);
    await expect(
      rail.getByText(
        human
          ? "Your turn is next. Resume to play your move."
          : "Explore the position. Resume or use Next move.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(await geometry()).toEqual(before);
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    const totals = page.getByRole("region", { name: "Operational totals" });
    const count = totals.getByText(/^Recorded attempts:/);
    await expect(count).toBeVisible();
    const recordedCount = await count.textContent();
    await expect(
      page.getByRole("button", { name: "Refresh details", exact: true }),
    ).toHaveAttribute("aria-disabled", "false");
    hold = true;
    releaseRecords = undefined;
    long = true;
    await page.getByRole("button", { name: "Refresh details", exact: true }).click();
    await expect.poll(() => Boolean(releaseRecords)).toBe(true);
    await expect(count).toHaveText(recordedCount!);
    await expect(commentary.getByText("Controls the center.", { exact: true })).toBeVisible();
    expect(await geometry()).toEqual(before);
    hold = false;
    releaseRecords!();
    await expect(commentary.getByText(longCommentary, { exact: true })).toBeVisible();
    expect(await geometry()).toEqual(before);
    await expect(page.getByRole("tab", { name: "Analysis", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
}

test("accepted-move commentary follows replay; Analysis shows totals and Events includes retries", async ({
  page,
}, testInfo) => {
  const gameId = await start(page, "telemetry-fixture");
  await page.getByLabel("Delay between moves").selectOption("500");
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Moves", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("region", { name: "Operational totals" })).toBeHidden();
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  const totals = page.getByRole("region", { name: "Operational totals" });
  await expect(totals.getByText("Recorded attempts: 6", { exact: true })).toBeVisible();
  await expect(totals.getByText("Unavailable", { exact: true })).toHaveCount(3);
  await expect(totals.getByText("Reported for 3 of 6 attempts", { exact: true })).toHaveCount(3);
  const response = await page.request.get(`${API_ORIGIN}/games/${gameId}/invocations`);
  const records = gameInvocationsSchema.parse(await response.json());
  const commentary = page.getByRole("region", { name: "Commentary & move details" });
  await expect(commentary.getByText("No commentary provided", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "First", exact: true }).click();
  await expect(commentary.getByText("Initial position · no move selected.")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    commentary.getByText('<img src=x onerror="alert(1)"> **Viewer note**', { exact: true }),
  ).toBeVisible();
  await expect(commentary.locator("img, script, strong")).toHaveCount(0);
  await expect(
    commentary.getByText(`${records.turns[0]!.attempts[2]!.durationMs!.toLocaleString("en")} ms`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(commentary.getByText("0", { exact: true })).toHaveCount(2);
  await expect(commentary.getByText("Total tokens", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(commentary.getByText("No commentary provided", { exact: true })).toBeVisible();
  await expect(commentary.getByText("Unavailable", { exact: true })).toHaveCount(2);
  const movesTab = page.getByRole("tab", { name: "Moves", exact: true });
  await movesTab.focus();
  await movesTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Analysis", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tabpanel", { name: "Analysis", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Events", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const events = page.getByRole("tabpanel", { name: "Events", exact: true });
  await expect(events.getByText("Invalid responses: 2 of 3", { exact: true })).toBeVisible();
  await expect(events.getByText("Attempt 3 · Move accepted", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("telemetry-replay.png"), fullPage: true });
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: /^Refresh details/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /^Refresh details/ })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("telemetry-expanded.png"), fullPage: true });
});

test("provider pause keeps the invalid budget and attempt history through manual retry and stopped replay", async ({
  page,
}, testInfo) => {
  const gameId = await start(page, "retry-fixture");
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  const events = page.getByRole("tabpanel", { name: "Events", exact: true });
  await expect(events.getByText("Invalid responses: 1 of 3", { exact: true })).toBeVisible();
  await expect(events.getByText("Attempt 2 · Provider failure", { exact: true })).toBeVisible();
  await expect(events.getByText("Paused for user-directed retry.", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel("White · OpenAI · API key", { exact: true }).fill("match-fixture");
  await page.getByLabel("Black · Anthropic · API key", { exact: true }).fill("match-fixture");
  await page.getByRole("button", { name: "Next move", exact: true }).click();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  await expect(events.getByText("Attempt 3 · Move accepted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop game", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Commentary & move details" })
      .getByText("No commentary provided", { exact: true }),
  ).toBeVisible();
  const previousUrl = page.url();
  const pgn = await page.request.get(`${API_ORIGIN}/games/${gameId}/pgn`);
  expect(pgn.status()).toBe(200);
  await page.getByRole("button", { name: "New game", exact: true }).click();
  await start(page, "slow-fixture");
  await page.goto(previousUrl);
  await expect(page.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  const totals = page.getByRole("region", { name: "Operational totals" });
  await expect(totals.getByText("Recorded attempts: 3", { exact: true })).toBeVisible();
  expect(await (await page.request.get(`${API_ORIGIN}/games/${gameId}/pgn`)).json()).toEqual(
    await pgn.json(),
  );
  await page.route("**/invocations", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.getByRole("button", { name: "Refresh details", exact: true }).click();
  await expect(totals.getByText(/Could not refresh details/)).toBeVisible();
  await expect(totals.getByText("Recorded attempts: 3", { exact: true })).toBeVisible();
  await page.unroute("**/invocations");
  await page.getByRole("button", { name: "Refresh details", exact: true }).click();
  await expect(totals.getByText("Recorded attempts: 3", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("telemetry-aborted.png"), fullPage: true });
});

test("live details stay within the primary controls across tabs and long commentary", async ({
  page,
}, testInfo) => {
  await start(page, "telemetry-fixture");
  await page.getByLabel("Delay between moves").selectOption("5000");
  const commentary = page.getByRole("region", { name: "Commentary & move details" });
  await expect(commentary.getByRole("heading", { name: "Black · 1. e5" })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  const desktop = testInfo.project.name === "desktop";
  const widths = desktop ? [1025, 1280, 1440, 1920] : [320, 390, 768, 1024];
  const rail = page.getByRole("complementary", { name: "Game details" });
  const controls = page.getByRole("region", { name: "Game controls" });
  const anchors = new Map<number, { tabs: number; cards: number[] }>();
  async function checkRail() {
    const railBounds = await rail.boundingBox();
    const controlsBounds = await controls.boundingBox();
    expect(railBounds).not.toBeNull();
    expect(controlsBounds).not.toBeNull();
    if (desktop) {
      expect(railBounds!.y + railBounds!.height).toBeCloseTo(
        controlsBounds!.y + controlsBounds!.height,
        0,
      );
      expect(
        await rail.evaluate((element) => element.scrollHeight - element.clientHeight),
      ).toBeLessThanOrEqual(1);
    } else {
      expect(railBounds!.y).toBeGreaterThan(controlsBounds!.y + controlsBounds!.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const geometry = await rail.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      return {
        tabs: element.querySelector('[role="tablist"]')!.getBoundingClientRect().top - top,
        cards: [...element.querySelectorAll("article")].map(
          (card) => card.getBoundingClientRect().height,
        ),
      };
    });
    const width = page.viewportSize()!.width;
    const previous = anchors.get(width);
    if (previous) expect(geometry).toEqual(previous);
    else anchors.set(width, geometry);
    await expectUnbrokenWords(rail.locator("button"));
    const moves = page.getByRole("tabpanel", { name: "Moves", exact: true });
    if (await moves.isVisible()) {
      const width = await moves.evaluate((panel) => {
        const history = panel.querySelector('[role="region"][tabindex="0"]')!;
        const table = history.querySelector("table")!;
        return {
          panelLeft: panel.getBoundingClientRect().left,
          panelRight: panel.getBoundingClientRect().right,
          historyLeft: history.getBoundingClientRect().left,
          historyRight: history.getBoundingClientRect().right,
          contentWidth: history.clientWidth,
          tableWidth: table.getBoundingClientRect().width,
        };
      });
      expect(width.historyLeft).toBeCloseTo(width.panelLeft, 0);
      expect(width.historyRight).toBeCloseTo(width.panelRight, 0);
      expect(width.tableWidth).toBeCloseTo(width.contentWidth, 0);
    }
  }
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["Moves", "Analysis", "Events"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await checkRail();
    }
  }
  await page.setViewportSize(desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  await page.getByRole("tab", { name: "Moves", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("telemetry-live-moves.png"), fullPage: true });
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("telemetry-live-analysis.png"),
    fullPage: true,
  });

  const longCommentary =
    "A longer explanation of the selected move and the current position. ".repeat(24);
  await page.route("**/invocations", async (route) => {
    const response = await route.fetch();
    const records = gameInvocationsSchema.parse(await response.json());
    await route.fulfill({
      response,
      json: {
        ...records,
        turns: records.turns.map((turn) => ({
          ...turn,
          attempts: turn.attempts.map((attempt) => ({
            ...attempt,
            commentary: attempt.outcome === "accepted" ? longCommentary : attempt.commentary,
          })),
        })),
      },
    });
  });
  await page.getByRole("button", { name: "Refresh details", exact: true }).click();
  await expect(commentary.getByText(longCommentary, { exact: true })).toHaveCount(2);
  const previewSizes = await commentary
    .getByText(longCommentary, { exact: true })
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.getBoundingClientRect().height,
          lineHeight: parseFloat(style.lineHeight),
          fontSize: parseFloat(style.fontSize),
        };
      }),
    );
  const headingSize = await commentary
    .getByRole("heading", { name: "Commentary & move details", exact: true })
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  for (const preview of previewSizes) {
    expect(preview.height).toBeCloseTo(preview.lineHeight * 2, 0);
    expect(headingSize).toBeGreaterThan(preview.fontSize);
  }
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["Moves", "Analysis", "Events"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await checkRail();
    }
  }
  const read = commentary.getByRole("button", { name: "Read full commentary: Black · 1. e5" });
  await read.click();
  const dialog = page.getByRole("dialog", { name: "Commentary · Black · 1. e5" });
  await expect(dialog.getByText(longCommentary, { exact: true })).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close commentary" });
  await expect(close).toBeInViewport();
  await expect(dialog.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
  if (desktop) {
    const restBackground = await close.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const dialogBackground = await dialog.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await close.hover();
    await expect(close).not.toHaveCSS("background-color", restBackground);
    await expect(close).not.toHaveCSS("background-color", dialogBackground);
    await dialog.screenshot({
      path: testInfo.outputPath("commentary-dialog-hover.png"),
      animations: "disabled",
    });
    await dialog.getByRole("heading").hover();
  }
  const titleBounds = (await dialog
    .getByRole("heading", { name: "Commentary · Black · 1. e5" })
    .boundingBox())!;
  const closeBounds = (await close.boundingBox())!;
  expect(closeBounds.x).toBeGreaterThanOrEqual(titleBounds.x + titleBounds.width);
  expect(closeBounds.y).toBeLessThan(titleBounds.y + titleBounds.height);
  expect(closeBounds.width).toBeGreaterThanOrEqual(44);
  expect(closeBounds.height).toBeGreaterThanOrEqual(44);
  await dialog.screenshot({ path: testInfo.outputPath("commentary-dialog.png") });
  expect((await new AxeBuilder({ page }).include("dialog").analyze()).violations).toEqual([]);
  await dialog.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(close).toBeInViewport();
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(read).toBeFocused();
  await read.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(read).toBeFocused();
  const events = page.getByRole("tabpanel", { name: "Events", exact: true });
  await events.focus();
  await page.keyboard.press("Control+End");
  await expect(events.getByRole("heading", { name: "Black · Move 1" })).toBeInViewport();
  expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual([]);
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await commentary.getByRole("button", { name: /^Read full commentary: Black/ }).click();
    const expanded = page.getByRole("dialog");
    await expect(expanded.getByRole("button", { name: /^Close commentary/ })).toBeInViewport();
    expect(await expanded.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("tab", { name: /^Analysis/ }).click();
    await page.getByRole("button", { name: /^Refresh details/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /^Refresh details/ })).toBeInViewport();
  }
});
