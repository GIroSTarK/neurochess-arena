import AxeBuilder from "@axe-core/playwright";

import type * as webI18n from "../../apps/web/src/i18n";
import { createReferenceGame } from "../../apps/web/src/reference/scenarios";

import { expectArenaLayout, expectArenaTransition, isArenaWide } from "./arena-layout";
import { API_ORIGIN, DISABLED_WEB_ORIGIN } from "./environment";
import { activate, expect, startSandbox, test } from "./fixtures";
import { expectSelectArrowSpacing } from "./select-controls";
import { setPseudoLocalization } from "./text-layout";

test("resizing retains inspected moves, player dialogs and readable compact identities", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/dev/arena");
  await page.getByLabel("Test scenario").selectOption("identical");
  await page.getByLabel("Reference state").selectOption("replay");
  await page.getByRole("button", { name: "View ply 2: e5", exact: true }).click();
  const board = page.getByRole("grid");
  const boardNode = await board.elementHandle();
  const fen = await board.getAttribute("data-fen");
  const transition = await expectArenaTransition(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("tab", { name: "Events", exact: true }).click();
  }
  const panel = page.getByRole("tabpanel", { name: "Events", exact: true });
  const panelNode = await panel.elementHandle();
  const trigger = page.getByRole("button", { name: /^View White identity:/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "White player", exact: true });
  const text = await dialog.textContent();
  const close = dialog.getByRole("button", { name: "Close player identity" });
  for (const width of [
    320,
    390,
    768,
    1024,
    1025,
    transition - 1,
    transition,
    transition + 1,
    1440,
  ]) {
    const dialogNode = await dialog.elementHandle();
    await page.setViewportSize({ width, height: width === 1440 ? 600 : 900 });
    await expect(close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    expect(await dialog.evaluate((current, original) => current === original, dialogNode)).toBe(
      true,
    );
    expect(await dialog.textContent()).toBe(text);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expectArenaLayout(page);
    expect(await board.evaluate((current, original) => current === original, boardNode)).toBe(true);
    expect(await panel.evaluate((current, original) => current === original, panelNode)).toBe(true);
    await expect(board).toHaveAttribute("data-fen", fen!);
    await expect(page.getByText("Ply 2 of 4", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Events", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const alignment = await page.evaluate(() => ({
      title: document.querySelector("h1")!.getBoundingClientRect().left,
      board: document.querySelector('[role="grid"]')!.getBoundingClientRect().left,
      names: [...document.querySelectorAll("[data-player-name]")].map((name) => ({
        height: name.getBoundingClientRect().height,
        line: Number.parseFloat(getComputedStyle(name).lineHeight),
      })),
    }));
    expect(Math.abs(alignment.title - alignment.board)).toBeLessThanOrEqual(1);
    for (const name of alignment.names) expect(name.height).toBeLessThanOrEqual(name.line * 2 + 1);
    await page.screenshot({ path: testInfo.outputPath(`identity-${width}.png`), fullPage: true });
    await trigger.click();
  }
  await page.keyboard.press("Escape");
  for (const scenario of ["identical", "humanHuman"]) {
    await page.getByLabel("Test scenario").selectOption(scenario);
    // Exercise maximum-length human names without adding production fixture behavior.
    await page.evaluate(async () => {
      const path = "/src/i18n/index.ts";
      const { i18n } = (await import(/* @vite-ignore */ path)) as typeof webI18n;
      i18n.addResourceBundle(
        "en",
        "translation",
        { reference: { humanWhite: "W".repeat(50), humanBlack: "B".repeat(50) } },
        true,
        true,
      );
    });
    await setPseudoLocalization(page, true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const width of [320, 390, 768, 1024, 1025, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectArenaLayout(page);
      for (const color of ["White", "Black"]) {
        const identity = page.locator(`[data-seat="${color.toLowerCase()}"]`).getByRole("button");
        await identity.click();
        const full = page.getByRole("dialog");
        await expect(full).toBeVisible();
        expect(await full.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await page.keyboard.press("Escape");
        await expect(identity).toBeFocused();
      }
    }
    await setPseudoLocalization(page, false);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
  }
});

test("shared arena reference: mixed seats, live and replay", async ({ page }, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/dev/arena");
  await expect(page).toHaveTitle("Arena test scenarios · Neurochess Arena");
  await expect(page.getByRole("region", { name: "Test data" })).toBeVisible();
  await expectSelectArrowSpacing(page.getByLabel("Test scenario"));
  await expectSelectArrowSpacing(page.getByLabel("Reference state"));
  await page.getByLabel("Test scenario").selectOption("humanAi");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const board = page.getByRole("grid", { name: "Chessboard" });
  await expect(board).toHaveAttribute("aria-readonly", "true");
  await expect(board).toHaveAttribute("data-orientation", "black");
  await expect(board).toHaveAttribute("data-fen", createReferenceGame(false).snapshot().fen);
  await expect(board.getByRole("gridcell")).toHaveCount(64);
  await expect(page.getByRole("button", { name: /^Resign / })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Resign Black" })).toBeVisible();
  if (!(await isArenaWide(page))) {
    await page.getByRole("tab", { name: "Commentary", exact: true }).click();
  }
  await expect(page.getByRole("group", { name: /^(White|Black) commentary$/ })).toHaveCount(1);
  await expect(page.getByRole("group", { name: /^(White|Black) telemetry$/ })).toHaveCount(1);
  await page.getByRole("tab", { name: "Moves", exact: true }).click();
  const white = await page.getByLabel("White player").boundingBox();
  const black = await page.getByLabel("Black player").boundingBox();
  expect(white).not.toBeNull();
  expect(black).not.toBeNull();
  expect(Math.abs(white!.width - black!.width)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await activate(page.getByRole("button", { name: "Pause", exact: true }), touch);
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeFocused();
  await activate(page.getByRole("button", { name: "Resume", exact: true }), touch);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("reference-mixed-live.png"), fullPage: true });
  await page.getByLabel("Reference state").selectOption("replay");
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
  await expect(board).toHaveAttribute("data-fen", createReferenceGame(true).snapshot().fen);
  await activate(page.getByRole("button", { name: "First", exact: true }), touch);
  await expect(page.getByText("Ply 0 of 4")).toBeVisible();
  if (!(await isArenaWide(page))) {
    await page.getByRole("tab", { name: "Commentary", exact: true }).click();
  }
  await expect(page.getByText("No commentary provided", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
  await page.getByRole("tab", { name: "Moves", exact: true }).click();
  await activate(page.getByRole("button", { name: "View ply 2: e5", exact: true }), touch);
  await expect(page.getByText("Ply 2 of 4")).toBeVisible();
  await expect(board).toHaveAttribute(
    "data-fen",
    createReferenceGame(true).snapshot().moves[1]!.fen,
  );
  const movesTab = page.getByRole("tab", { name: "Moves", exact: true });
  await movesTab.focus();
  await page.keyboard.press("ArrowRight");
  if (!(await isArenaWide(page))) {
    await expect(page.getByRole("tab", { name: "Commentary", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
  }
  await expect(page.getByRole("tab", { name: "Analysis", exact: true })).toBeFocused();
  await expect(movesTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tabpanel", { name: "Analysis", exact: true })).toContainText(
    "No Stockfish analysis was run",
  );
  await page.keyboard.press("End");
  await page.keyboard.press("Space");
  await expect(page.getByRole("tabpanel", { name: "Events", exact: true })).toContainText(
    "Ply 2 · e5",
  );
  await expect(page.getByRole("tabpanel", { name: "Events", exact: true })).not.toContainText(
    "Qh4#",
  );
  await activate(movesTab, touch);
  await expect(page.getByRole("button", { name: "View ply 2: e5", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await activate(page.getByRole("button", { name: "Last", exact: true }), touch);
  await expect(page.getByText("Ply 4 of 4")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("reference-mixed-replay.png"),
    fullPage: true,
  });
  expect(apiRequests).toEqual([]);
});

test("reference geometry keeps human controls aligned and identical long names readable", async ({
  page,
}, testInfo) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/dev/arena");
  await page.getByLabel("Test scenario").selectOption("humanHuman");
  await expectArenaTransition(page);
  if (!testInfo.project.use.isMobile) {
    const flip = await page.getByRole("button", { name: "Flip board" }).boundingBox();
    const board = await page.getByRole("grid").boundingBox();
    expect(flip).not.toBeNull();
    expect(board).not.toBeNull();
    expect(Math.abs(flip!.x - board!.x)).toBeLessThan(2);
  }
  // Capabilities and all five seat mappings belong to arena-reference-screen.test.tsx.
  for (const scenario of ["humanHuman", "identical"]) {
    await page.getByLabel("Test scenario").selectOption(scenario);
    const white = await page.getByLabel("White player").boundingBox();
    const black = await page.getByLabel("Black player").boundingBox();
    expect(white).not.toBeNull();
    expect(black).not.toBeNull();
    expect(Math.abs(white!.width - black!.width)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  for (const state of ["live", "replay"]) {
    await page.getByLabel("Reference state").selectOption(state);
    await page.screenshot({
      path: testInfo.outputPath(`reference-identical-${state}.png`),
      fullPage: true,
    });
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const color of ["White", "Black"]) {
    await expect(page.getByLabel(`${color} player`)).toContainText(
      "Model-A-Experimental-LongContext",
    );
  }
  await page.screenshot({
    path: testInfo.outputPath("reference-identical-enlarged.png"),
    fullPage: true,
  });
  expect(apiRequests).toEqual([]);
});
test("reference abortion explains temporary replay and preserves confirmation focus", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/dev/arena");
  await expect(page).toHaveTitle("Arena test scenarios · Neurochess Arena");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Abort game" });
  await activate(trigger, touch);
  const dialog = page.getByRole("dialog", { name: "Stop this game?" });
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await expect(dialog).toHaveAccessibleDescription(
    "This stops the local fixture without awarding a win or loss. Replay is available on this page; reloading or changing the scenario or reference state resets it.",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("reference-abort.png") });
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Stop game" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("region", { name: "Replay" })).toHaveCount(0);
  await activate(trigger, touch);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await activate(dialog.getByRole("button", { name: "Stop game" }), touch);
  await expect(page.getByRole("heading", { name: "Game stopped" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Replay" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Copy|Download) PGN$/ })).toHaveCount(0);
  await activate(page.getByRole("button", { name: "First", exact: true }), touch);
  await expect(page.getByText("Ply 0 of 3")).toBeVisible();
  await page.reload();
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("region", { name: "Replay" })).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});

test("reference data stays out of Sandbox and is unavailable when Sandbox is disabled", async ({
  page,
}, testInfo) => {
  await page.goto(DISABLED_WEB_ORIGIN + "/dev/arena");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await startSandbox(page, Boolean(testInfo.project.use.hasTouch));
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Test data" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Commentary" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Illustrative telemetry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Resign / })).toHaveCount(2);
});
