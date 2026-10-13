import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { gameSnapshotSchema } from "@neurochess/contracts";

import { expectClipboardCopy } from "./clipboard";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import {
  acceptedMove,
  activate,
  expect,
  playMove,
  readSnapshot,
  square,
  startSandbox,
  test,
} from "./fixtures";
import { expectUnbrokenWords } from "./text-layout";

const promotionApproach = ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2"];

test("preserves lifecycle keyboard focus through pending commands without stealing it back", async ({
  page,
}, testInfo) => {
  await startSandbox(page, Boolean(testInfo.project.use.hasTouch));
  const secondaryActions = page.getByRole("button", {
    name: /^(Abort game|Resign White|Resign Black)$/,
  });
  await expect(secondaryActions).toHaveCount(3);
  const actionFrames = () =>
    secondaryActions.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return { border: style.borderColor, background: style.backgroundColor };
      }),
    );
  const initialFrames = await actionFrames();
  let release = Promise.withResolvers<void>();
  let requests = 0;
  await page.route(API_ORIGIN + "/games/*/lifecycle", async (route) => {
    requests += 1;
    await release.promise;
    await route.continue();
  });

  try {
    for (const [index, action] of ["Pause", "Resume", "Pause"].entries()) {
      release = Promise.withResolvers<void>();
      const control = page.getByRole("button", { name: action, exact: true });
      await control.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => requests).toBe(index + 1);
      await expect(control).toBeFocused();
      await expect(control).toHaveAttribute("aria-disabled", "true");
      for (const action of await secondaryActions.all()) {
        await expect(action).toHaveAttribute("aria-disabled", "true");
      }
      await expect.poll(actionFrames).toEqual(initialFrames);
      if (index === 0) {
        await page
          .getByRole("group", { name: "Game controls" })
          .screenshot({ path: testInfo.outputPath("controls-pending.png") });
      }
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      expect(requests).toBe(index + 1);

      if (index === 2) {
        await square(page, "e2").focus();
        await expect(square(page, "e2")).toBeFocused();
      }
      release.resolve();
      const next = page.getByRole("button", {
        name: action === "Pause" ? "Resume" : "Pause",
        exact: true,
      });
      await expect(next).toHaveAttribute("aria-disabled", "false");
      await expect.poll(actionFrames).toEqual(initialFrames);
      if (index === 2) await expect(square(page, "e2")).toBeFocused();
      else await expect(next).toBeFocused();
    }
    expect(requests).toBe(3);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("creates, recovers, completes, replays and exports a private game", async ({
  page,
  browserName,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  let current = await startSandbox(page, touch);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  for (const move of ["f2f3", "e7e5"]) {
    current = await playMove(page, current, move, touch);
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
  const paused = await readSnapshot(page, current.gameId);
  expect(paused).toEqual({
    ...current,
    version: current.version + 1,
    state: "paused",
    legalMoves: [],
  });
  const resume = page.waitForResponse(
    (response) => response.url().endsWith("/lifecycle") && response.status() === 200,
  );
  await activate(page.getByRole("button", { name: "Resume", exact: true }), touch);
  current = gameSnapshotSchema.parse(await (await resume).json());
  await expect(page.getByRole("heading", { name: "White to move" })).toBeVisible();
  for (const move of ["g2g4", "d8h4"]) current = await playMove(page, current, move, touch);
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await expect(square(page, "e1")).toHaveAttribute("data-check", "true");
  const restored = await readSnapshot(page, current.gameId);
  expect(restored).toEqual(current);
  expect(restored).toMatchObject({
    state: "completed",
    result: "0-1",
    terminationReason: "checkmate",
  });
  expect(restored.pgn).toContain("Qh4#");
  expect(restored.pgn.trim().endsWith("0-1")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("checkmate.png"), fullPage: true });
  await expect(page.getByRole("button", { name: "First", exact: true })).toBeEnabled();
  await activate(page.getByRole("button", { name: "First", exact: true }), touch);
  await expect(page.getByRole("grid")).toHaveAttribute(
    "data-fen",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  );
  await expect(square(page, "e1")).not.toHaveAttribute("data-check");
  for (const move of restored.moves) {
    await activate(
      page.getByRole("button", { name: "View ply " + move.ply + ": " + move.san, exact: true }),
      touch,
    );
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", move.fen);
  }
  await activate(page.getByRole("button", { name: "Previous", exact: true }), touch);
  await expect(square(page, "e1")).not.toHaveAttribute("data-check");
  await activate(page.getByRole("button", { name: "Next", exact: true }), touch);
  await expect(square(page, "e1")).toHaveAttribute("data-check", "true");
  await expectClipboardCopy(
    page,
    page.getByRole("button", { name: "Copy PGN", exact: true }),
    restored.pgn,
    browserName,
    touch,
  );
  await expect(page.getByText("PGN copied.", { exact: true }).first()).toBeVisible();
  const downloading = page.waitForEvent("download");
  await activate(page.getByRole("button", { name: "Download PGN", exact: true }), touch);
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("neurochess-" + current.gameId + ".pgn");
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  expect(await readFile(path, "utf8")).toBe(restored.pgn);
  expect(await readSnapshot(page, current.gameId)).toEqual(restored);
  const creation = page.waitForResponse(
    (response) =>
      response.url() === API_ORIGIN + "/sandbox/games" && response.request().method() === "POST",
  );
  await activate(page.getByRole("button", { name: "New game" }), touch);
  const response = await creation;
  expect(response.status(), "Sandbox game creation must return HTTP 201").toBe(201);
  const next = gameSnapshotSchema.parse(await response.json());
  expect(next.gameId).not.toBe(current.gameId);
  expect(next.version).toBe(0);
  expect(next.moves).toEqual([]);
  await expect(page).toHaveURL(new RegExp("/sandbox/games/" + next.gameId + "$"));
  await expect(page.getByRole("heading", { name: "White to move" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp("/sandbox/games/" + restored.gameId + "$"));
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
  await expect(page.getByText("Your current game is open.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Your game is open.");
  expect(new URL(page.url()).pathname).toBe("/sandbox/games/" + restored.gameId);
  expect(await readSnapshot(page, restored.gameId)).toEqual(restored);
});

test("promotes both colors from the standard position with modal cancellation and underpromotion", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  let current = await startSandbox(page, touch);
  for (const move of promotionApproach) current = await playMove(page, current, move, touch);
  if (touch) {
    await activate(square(page, "b7"), true);
    await activate(square(page, "a8"), true);
  } else {
    await square(page, "b7").focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
  }
  const dialog = page.getByRole("dialog", { name: "Choose a piece for White on a8" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Promote to Queen" })).toBeFocused();
  await expect(square(page, "b7")).toHaveAttribute("aria-label", /White pawn/);
  expect(await readSnapshot(page, current.gameId)).toEqual(current);
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Promote to Queen" })).toBeFocused();
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const choices = await dialog
    .getByRole("button", { name: /^Promote to / })
    .evaluateAll((elements) =>
      elements.map((element) => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        top: element.getBoundingClientRect().top,
      })),
    );
  expect(choices.every((choice) => choice.width >= 44 && choice.height >= 44)).toBe(true);
  if (touch) expect(new Set(choices.map((choice) => choice.top)).size).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("promotion.png"), fullPage: true });
  for (const enlarged of [false, true]) {
    await page.evaluate((enlarged) => {
      document.documentElement.style.fontSize = enlarged ? "200%" : "";
    }, enlarged);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          fits:
            rect.left >= 16 &&
            rect.right <= window.innerWidth - 16 &&
            element.scrollWidth <= element.clientWidth,
          targets: [...element.querySelectorAll("button")].every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width >= 44 && rect.height >= 44;
          }),
        };
      });
      expect(layout).toEqual({ fits: true, targets: true });
      await expectUnbrokenWords(dialog.getByRole("button"));
      for (const choice of await dialog.getByRole("button").all()) {
        await choice.focus();
        await expect(choice).toBeInViewport();
      }
      if (width === 320 && enlarged) {
        await page.screenshot({
          path: testInfo.outputPath("promotion-320-enlarged.png"),
          fullPage: true,
        });
      }
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.setViewportSize(testInfo.project.use.viewport!);
  const beforeCancel = await page.evaluate(() => window.scrollY);
  if (touch) await activate(dialog.getByRole("button", { name: "Cancel" }), true);
  else await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(square(page, "a8")).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeCancel);
  await expect(square(page, "b7")).toHaveAttribute("data-selected", "true");
  if (touch) await activate(square(page, "a8"), true);
  else await page.keyboard.press("Enter");
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/games/" + current.gameId + "/moves"),
  );
  if (touch) await activate(dialog.getByRole("button", { name: "Promote to Knight" }), true);
  else {
    for (let index = 0; index < 3; index += 1) await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Promote to Knight" })).toBeFocused();
    await page.keyboard.press("Space");
  }
  current = await acceptedMove(await response, current, "b7a8n", page);
  current = await playMove(page, current, "g2h1r", touch);
  await expect(square(page, "a8").locator("[data-piece=white-n]")).toHaveCount(1);
  await expect(square(page, "h1").locator("[data-piece=black-r]")).toHaveCount(1);
  const restored = await readSnapshot(page, current.gameId);
  expect(restored).toEqual(current);
  expect(restored.fen).toBe("Nnbqkbnr/p1ppppp1/8/8/8/8/1PPPPP1P/RNBQKBNr w Qk - 0 6");
  expect(restored.moves.slice(-2).map((move) => move.uci)).toEqual(["b7a8n", "g2h1r"]);
});

test("discovers an unfinished game on reopening and keeps repeated recovery paused", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  let current = await startSandbox(page, touch);
  current = await playMove(page, current, "e2e4", touch);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up a game", exact: true })).toBeVisible();
  expect(await readSnapshot(page, current.gameId)).toEqual(current);
  await activate(page.getByRole("navigation").getByRole("link", { name: "Sandbox" }), touch);
  await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
  const paused = await readSnapshot(page, current.gameId);
  expect(paused).toEqual({
    ...current,
    state: "paused",
    version: current.version + 1,
    legalMoves: [],
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
  expect(await readSnapshot(page, current.gameId)).toEqual(paused);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await page.goto("/sandbox");
  await expect(page).toHaveURL(new RegExp("/sandbox/games/" + current.gameId + "$"));
  await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
  // Discovery on document load replaces the entry path without moving focus.
  expect(
    await page.evaluate(
      () =>
        new Promise<boolean>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(document.activeElement === document.body)),
          ),
        ),
    ),
  ).toBe(true);
});

test("confirms both resignation colors and abortion with accessible cancellation", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  for (const ending of [
    {
      action: "Resign White",
      title: "Resign White?",
      confirm: "Confirm resignation",
      heading: "Black wins by resignation",
      result: "0-1",
      reason: "human_resignation",
    },
    {
      action: "Resign Black",
      title: "Resign Black?",
      confirm: "Confirm resignation",
      heading: "White wins by resignation",
      result: "1-0",
      reason: "human_resignation",
    },
    {
      action: "Abort game",
      title: "Stop this game?",
      confirm: "Stop game",
      heading: "Game stopped",
      result: "*",
      reason: "aborted",
    },
  ]) {
    const initial = await startSandbox(page, touch);
    const trigger = page.getByRole("button", { name: ending.action, exact: true });
    await activate(trigger, touch);
    let dialog = page.getByRole("dialog", { name: ending.title, exact: true });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    if (ending.reason === "aborted") {
      await expect(dialog).toHaveAccessibleDescription(
        "This ends the game without awarding a win or loss. Its moves remain available for replay and PGN export during your guest session.",
      );
      await page.screenshot({ path: testInfo.outputPath("sandbox-abort.png") });
    }
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: ending.confirm })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    expect(await readSnapshot(page, initial.gameId)).toEqual(initial);
    await activate(trigger, touch);
    dialog = page.getByRole("dialog", { name: ending.title, exact: true });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await activate(dialog.getByRole("button", { name: ending.confirm }), touch);
    await expect(page.getByRole("heading", { name: ending.heading })).toBeVisible();
    const terminal = await readSnapshot(page, initial.gameId);
    expect(terminal).toMatchObject({
      result: ending.result,
      terminationReason: ending.reason,
      moves: [],
    });
    await expect(page.getByRole("button", { name: "First", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Last", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "New game" })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("heading", { name: ending.heading })).toBeVisible();
    await expect(page.getByText("Your current game is open.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Your game is open.");
    await expect(page.getByRole("status")).not.toContainText("in progress");
  }
});

test("an isolated browser guest cannot open, replay or export another guest's private URL", async ({
  page,
  newContext,
  allowedIdentity401s,
  expectedGame404s,
}, testInfo) => {
  const initial = await startSandbox(page, Boolean(testInfo.project.use.hasTouch));
  const isolated = await newContext();
  try {
    const stranger = await isolated.newPage();
    allowedIdentity401s.set(stranger, new Set([`${API_ORIGIN}/games/${initial.gameId}`]));
    await stranger.goto(page.url());
    await expect(stranger.getByRole("button", { name: "Start sandbox again" })).toBeVisible();
    await expect(stranger.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    await expect(stranger.getByRole("grid")).toHaveAttribute(
      "data-fen",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
    await expect(stranger.getByRole("region", { name: "Move history" })).toHaveCount(0);
    for (const suffix of ["replay", "pgn"]) {
      expect(
        (
          await isolated.request.get(API_ORIGIN + "/games/" + initial.gameId + "/" + suffix)
        ).status(),
      ).toBe(401);
    }
    expect(
      (
        await isolated.request.post(API_ORIGIN + "/guest-session", {
          data: {},
          headers: { Origin: WEB_ORIGIN },
        })
      ).status(),
    ).toBe(200);
    allowedIdentity401s.delete(stranger);
    expectedGame404s.set(stranger, new Set([`${API_ORIGIN}/games/${initial.gameId}`]));
    await stranger.reload();
    await expect(stranger.getByRole("button", { name: "Start sandbox again" })).toBeVisible();
    await expect(stranger.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    await expect(stranger.getByRole("grid")).toHaveAttribute(
      "data-fen",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
    await expect(stranger.getByRole("region", { name: "Move history" })).toHaveCount(0);
    for (const suffix of ["replay", "pgn"]) {
      expect(
        (
          await isolated.request.get(API_ORIGIN + "/games/" + initial.gameId + "/" + suffix)
        ).status(),
      ).toBe(404);
    }
  } finally {
    await isolated.close();
  }
});
