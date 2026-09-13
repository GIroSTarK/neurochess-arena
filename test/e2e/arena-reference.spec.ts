import AxeBuilder from "@axe-core/playwright";

import { createReferenceGame } from "../../apps/web/src/reference/scenarios";

import { API_ORIGIN, DISABLED_WEB_ORIGIN } from "./environment";
import { activate, expect, startSandbox, test } from "./fixtures";

for (const scenario of [
  { id: "humanHuman", models: 0, human: "White" },
  { id: "aiHuman", models: 1, human: "White" },
  { id: "humanAi", models: 1, human: "Black" },
  { id: "aiAi", models: 2, human: null },
  { id: "identical", models: 2, human: null },
]) {
  test(`shared arena reference: ${scenario.id}, live and replay`, async ({ page }, testInfo) => {
    const touch = testInfo.project.name === "mobile-touch";
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
    });
    await page.goto("/dev/arena");
    await expect(page).toHaveTitle("Arena test scenarios · Neurochess Arena");
    await expect(page.getByRole("region", { name: "Test data" })).toBeVisible();
    await page.getByLabel("Test scenario").selectOption(scenario.id);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const board = page.getByRole("grid", { name: "Chessboard" });
    await expect(board).toHaveAttribute("aria-readonly", "true");
    await expect(board).toHaveAttribute("data-fen", createReferenceGame(false).snapshot().fen);
    await expect(board.getByRole("gridcell")).toHaveCount(64);
    await expect(page.getByRole("button", { name: /^Resign / })).toHaveCount(
      scenario.human ? 1 : 0,
    );
    if (scenario.human) {
      await expect(page.getByRole("button", { name: `Resign ${scenario.human}` })).toBeVisible();
    }
    await expect(page.getByRole("group", { name: /^(White|Black) commentary$/ })).toHaveCount(
      scenario.models,
    );
    await expect(page.getByRole("group", { name: /^(White|Black) telemetry$/ })).toHaveCount(
      scenario.models,
    );
    const white = await page.getByLabel("White player").boundingBox();
    const black = await page.getByLabel("Black player").boundingBox();
    expect(white).not.toBeNull();
    expect(black).not.toBeNull();
    expect(Math.abs(white!.width - black!.width)).toBeLessThan(2);
    if (scenario.id === "humanHuman" && !touch) {
      const flip = await page.getByRole("button", { name: "Flip board" }).boundingBox();
      const boardBounds = await board.boundingBox();
      expect(Math.abs(flip!.x - boardBounds!.x)).toBeLessThan(2);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (scenario.models > 0) {
      await activate(page.getByRole("button", { name: "Pause", exact: true }), touch);
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeFocused();
      await activate(page.getByRole("button", { name: "Resume", exact: true }), touch);
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeFocused();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath(`reference-${scenario.id}-live.png`),
      fullPage: true,
    });
    await page.getByLabel("Reference state").selectOption("replay");
    await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
    await expect(board).toHaveAttribute("data-fen", createReferenceGame(true).snapshot().fen);
    await activate(page.getByRole("button", { name: "First", exact: true }), touch);
    await expect(page.getByText("Ply 0 of 4")).toBeVisible();
    if (scenario.models > 0) {
      await expect(page.getByText("No commentary provided", { exact: true })).toHaveCount(
        scenario.models,
      );
      await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(scenario.models * 3);
    }
    await activate(page.getByRole("button", { name: "View ply 2: e5", exact: true }), touch);
    await expect(page.getByText("Ply 2 of 4")).toBeVisible();
    await expect(board).toHaveAttribute(
      "data-fen",
      createReferenceGame(true).snapshot().moves[1]!.fen,
    );
    if (scenario.models > 0) {
      const movesTab = page.getByRole("tab", { name: "Moves", exact: true });
      await movesTab.focus();
      await page.keyboard.press("ArrowRight");
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
      await expect(
        page.getByRole("button", { name: "View ply 2: e5", exact: true }),
      ).toHaveAttribute("aria-current", "step");
    }
    await activate(page.getByRole("button", { name: "Last", exact: true }), touch);
    await expect(page.getByText("Ply 4 of 4")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath(`reference-${scenario.id}-replay.png`),
      fullPage: true,
    });
    if (scenario.id === "identical") {
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.setViewportSize({ width: 320, height: 844 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect(page.getByLabel("White player")).toContainText(
        "Model-A-Experimental-LongContext",
      );
      await expect(page.getByLabel("Black player")).toContainText(
        "Model-A-Experimental-LongContext",
      );
      await page.screenshot({
        path: testInfo.outputPath("reference-identical-enlarged.png"),
        fullPage: true,
      });
    }
    expect(apiRequests).toEqual([]);
  });
}

test("reference data stays out of Sandbox and is unavailable when Sandbox is disabled", async ({
  page,
}, testInfo) => {
  await page.goto(DISABLED_WEB_ORIGIN + "/dev/arena");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await startSandbox(page, testInfo.project.name === "mobile-touch");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Test data" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Commentary" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Illustrative telemetry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Resign / })).toHaveCount(2);
});
