import AxeBuilder from "@axe-core/playwright";
import { gameDetailsSchema, type MoveCommand } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { acceptedMove, activate, expect, playMove, readSnapshot, square, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

async function start(page: Page, color: "white" | "black", key = "match-fixture") {
  await page.goto("/");
  await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
  await page.getByLabel("Game mode").selectOption("ai_vs_human");
  await page.getByLabel("Your color").selectOption(color);
  const ai = page.getByRole("group", { name: color === "white" ? "Black" : "White", exact: true });
  await ai.getByLabel("Provider", { exact: true }).selectOption("openai");
  await ai.getByLabel("API key", { exact: true }).fill(key);
  await ai.getByRole("button", { name: "Load models", exact: true }).click();
  const model = ai.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
  const creation = page.waitForResponse(
    (response) => response.url() === API_ORIGIN + "/games" && response.status() === 201,
  );
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  const details = gameDetailsSchema.parse(await (await creation).json());
  expect(details.configuration).toMatchObject({
    mode: "ai_vs_human",
    seats: { [color]: { type: "human" } },
  });
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(page.getByRole("grid").locator("[data-square]").first()).toHaveAttribute(
    "data-square",
    color === "white" ? "a8" : "h1",
  );
  await expect(
    page.getByRole("button", {
      name: color === "white" ? "Resign Black" : "Resign White",
      exact: true,
    }),
  ).toHaveCount(0);
  return details.snapshot;
}

async function resign(page: Page, color: "white" | "black") {
  await page
    .getByRole("button", { name: color === "white" ? "Resign White" : "Resign Black", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Confirm resignation", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: color === "white" ? "Black wins by resignation" : "White wins by resignation",
      exact: true,
    }),
  ).toBeVisible();
}

for (const human of ["white", "black"] as const) {
  test(`${human} human plays a natural match with AI-first coordination and private replay`, async ({
    page,
  }, testInfo) => {
    let turns = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/ai-turn")) turns++;
    });
    const game = await start(page, human);
    const touch = testInfo.project.name === "mobile-touch";
    const url = page.url();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    expect(turns).toBe(human === "white" ? 0 : 1);
    await page.getByLabel("Delay between moves").selectOption("500");
    const line = ["f2f3", "e7e5", "g2g4", "d8h4"];
    for (let ply = human === "white" ? 0 : 1; ply < 4; ply += 2) {
      await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
      const current = await readSnapshot(page, game.gameId);
      expect(current.moves).toHaveLength(ply);
      const move = line[ply]!;
      if (!touch) {
        await square(page, move.slice(0, 2)).focus();
        await page.keyboard.press("Space");
        await square(page, move.slice(2, 4)).focus();
        const response = page.waitForResponse((response) =>
          response.url().endsWith(`/games/${game.gameId}/moves`),
        );
        await page.keyboard.press("Enter");
        await acceptedMove(await response, current, move, page);
      } else await playMove(page, current, move, true);
      await expect
        .poll(async () => (await readSnapshot(page, game.gameId)).moves.length)
        .toBe(Math.min(ply + 2, 4));
    }
    await expect(
      page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
    ).toBeVisible();
    expect(turns).toBe(2);
    const final = await readSnapshot(page, game.gameId);
    expect(final.moves.map((move) => move.uci)).toEqual(line);
    await page.getByRole("button", { name: "First", exact: true }).click();
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", game.fen);
    await page.getByRole("button", { name: "Last", exact: true }).click();
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", final.fen);
    expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({
      path: testInfo.outputPath(`human-${human}-replay.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "New game", exact: true }).click();
    await page.goto(url);
    await expect(
      page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
    ).toBeVisible();
  });

  test(`${human} human recovers with one AI key and resigns while paused off-turn`, async ({
    page,
  }, testInfo) => {
    const game = await start(page, human);
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    const before = await readSnapshot(page, game.gameId);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    expect((await readSnapshot(page, game.gameId)).moves).toEqual(before.moves);
    const input = page.getByLabel(/· OpenAI · API key/, { exact: false });
    await expect(input).toHaveCount(1);
    await expect(input).toHaveValue("");
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await input.fill("slow-fixture");
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    await expect(page.getByRole("button", { name: "Next move", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    const current = await readSnapshot(page, game.gameId);
    await playMove(
      page,
      current,
      human === "white" ? "f2f3" : "e7e5",
      testInfo.project.name === "mobile-touch",
    );
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    await resign(page, human);
    expect((await readSnapshot(page, game.gameId)).terminationReason).toBe("human_resignation");
  });

  test(`${human} human retries a provider pause and inspects the disabled board`, async ({
    page,
  }, testInfo) => {
    const game = await start(page, human, "quota-fixture");
    if (human === "white") {
      await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
      await playMove(page, game, "f2f3", testInfo.project.name === "mobile-touch");
    }
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    await expect(page.getByText(/The provider reported a quota/).first()).toBeVisible();
    await square(page, "e4").focus();
    await page.keyboard.press("ArrowRight");
    await expect(square(page, human === "white" ? "f4" : "d4")).toBeFocused();
    await page.getByRole("button", { name: /Flip board/ }).click();
    await page.getByLabel(/· OpenAI · API key/).fill("match-fixture");
    const before = await readSnapshot(page, game.gameId);
    await page.getByRole("button", { name: "Next move", exact: true }).click();
    await expect
      .poll(async () => (await readSnapshot(page, game.gameId)).moves.length)
      .toBe(before.moves.length + 1);
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next move", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await resign(page, human);
  });

  test(`${human} human promotes through legal play with cancellation and underpromotion`, async ({
    page,
  }, testInfo) => {
    const game = await start(page, human, "promotion-fixture");
    const touch = testInfo.project.name === "mobile-touch";
    await page.getByLabel("Delay between moves").selectOption("500");
    const approach = ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2", "b7a8n"];
    const promotionPly = human === "white" ? 8 : 9;
    for (let ply = human === "white" ? 0 : 1; ply < promotionPly; ply += 2) {
      await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
      await playMove(page, await readSnapshot(page, game.gameId), approach[ply]!, touch);
      await expect
        .poll(async () => (await readSnapshot(page, game.gameId)).moves.length)
        .toBe(ply + 2);
    }
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    const before = await readSnapshot(page, game.gameId);
    const move = human === "white" ? "b7a8n" : "g2h1r";
    await activate(square(page, move.slice(0, 2)), touch);
    await activate(square(page, move.slice(2, 4)), touch);
    await expect(page.getByRole("dialog", { name: /Choose a piece/ })).toBeVisible();
    expect(await readSnapshot(page, game.gameId)).toEqual(before);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(square(page, move.slice(2, 4))).toBeFocused();
    await activate(square(page, move.slice(2, 4)), touch);
    await page.screenshot({
      path: testInfo.outputPath(`human-${human}-promotion.png`),
      fullPage: true,
    });
    const response = page.waitForResponse((response) =>
      response.url().endsWith(`/games/${game.gameId}/moves`),
    );
    await activate(
      page
        .getByRole("dialog")
        .getByRole("button", { name: human === "white" ? "Promote to Knight" : "Promote to Rook" }),
      touch,
    );
    await acceptedMove(await response, before, move, page);
    await resign(page, human);
  });
}

for (const committed of [false, true]) {
  test(`duplicate human activation and ${committed ? "committed" : "uncommitted"} uncertain acknowledgement preserve command identity`, async ({
    page,
  }) => {
    const commands: MoveCommand[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/moves", async (route) => {
      commands.push(route.request().postDataJSON() as MoveCommand);
      if (commands.length > 1) {
        await route.continue();
        return;
      }
      const response = committed ? await route.fetch() : null;
      await gate;
      await route.fulfill({ json: {}, status: response?.status() ?? 200 });
    });
    const game = await start(page, "white");
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await square(page, "f2").click();
    await square(page, "f3").dblclick();
    await expect.poll(() => commands.length).toBe(1);
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", game.fen);
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    release();
    await expect(
      page.getByRole("button", { name: "Synchronize and pause", exact: true }),
    ).toBeVisible();
    if (committed) {
      await expect(page.getByRole("button", { name: "Retry same move", exact: true })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "Synchronize and pause", exact: true }).click();
    } else {
      const retry = page.getByRole("button", { name: "Retry same move", exact: true });
      await expect(retry).toHaveAttribute("aria-disabled", "false");
      await retry.click();
      expect(commands[1]).toEqual(commands[0]);
    }
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    expect((await readSnapshot(page, game.gameId)).moves.map((move) => move.uci)).toEqual(["f2f3"]);
    await resign(page, "white");
  });
}

test("human can resign during a pending AI opening and refresh into the same terminal result", async ({
  page,
}) => {
  const game = await start(page, "black", "slow-fixture");
  await expect(
    page.getByRole("heading", { name: "White is choosing a move…", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await resign(page, "black");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "White wins by resignation", exact: true }),
  ).toBeVisible();
  expect((await readSnapshot(page, game.gameId)).moves).toEqual([]);
});

test("human mode and color selection work by keyboard with expanded mobile setup", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const mode = page.getByRole("combobox", { name: "Game mode", exact: true });
  await expect(mode).toHaveAttribute("aria-disabled", "false");
  await mode.focus();
  await mode.press("ArrowDown");
  await mode.press("Enter");
  await expect(mode).toHaveValue("ai_vs_human");
  const color = page.getByRole("combobox", { name: "Your color", exact: true });
  await color.focus();
  await color.press("ArrowDown");
  await color.press("Enter");
  await expect(color).toHaveValue("black");
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(1);
  expect((await new AxeBuilder({ page }).include("#arena-setup").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("human-setup.png"), fullPage: true });
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("combobox", { name: /^Game mode/ }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: /^Your color/ })).toBeFocused();
    await expect(page.getByRole("combobox", { name: /^Your color/ })).toBeInViewport();
  }
});

test("human controls fit mobile and expanded text", async ({ page }, testInfo) => {
  await start(page, "white");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const resignButton = page.getByRole("button", { name: /^Resign White/ });
    await resignButton.focus();
    await expect(resignButton).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath("human-expanded.png"), fullPage: true });
  await setPseudoLocalization(page, false);
  await resign(page, "white");
});
