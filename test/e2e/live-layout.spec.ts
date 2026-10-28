import { gameSnapshotSchema } from "@neurochess/contracts";
import type { Locator } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { expectArenaLayout, expectArenaTransition } from "./arena-layout";
import { configureCredential } from "./credential-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import {
  activate,
  expect,
  playMove,
  readSnapshot,
  square,
  startSandbox,
  submitGame,
  test,
} from "./fixtures";
import { createRoom, joinRoom } from "./room-helpers";

test("long history stays inside the inspector above the next action across the arena transition", async ({
  page,
  newContext,
}) => {
  const { invitation, gameId } = await createRoom(page, "White");
  const peer = await (await newContext()).newPage();
  await joinRoom(peer, invitation, gameId);
  await page.getByRole("link", { name: "Arena", exact: true }).click();
  await peer.getByRole("link", { name: "Arena", exact: true }).click();
  let snapshot = await readSnapshot(page, gameId);
  const moves = (
    "a2a3 a7a6 b2b3 b7b6 c2c3 c7c6 d2d3 d7d6 e2e3 e7e6 f2f3 f7f6 g2g3 g7g6 h2h3 h7h6 " +
    "a3a4 a6a5 b3b4 b6b5 c3c4 c6c5 d3d4 d6d5 e3e4 e6e5 f3f4 f6f5 g3g4 g6g5 h3h4 h6h5"
  ).split(" ");
  for (const move of moves) {
    const request = snapshot.turn === "white" ? page.request : peer.request;
    const response = await request.post(`${API_ORIGIN}/games/${gameId}/moves`, {
      headers: { origin: WEB_ORIGIN },
      data: { gameId, move, expectedVersion: snapshot.version, commandId: crypto.randomUUID() },
    });
    expect(response.status()).toBe(200);
    snapshot = gameSnapshotSchema.parse(await response.json());
  }
  const stopped = await page.request.post(`${API_ORIGIN}/games/${gameId}/lifecycle`, {
    headers: { origin: WEB_ORIGIN },
    data: {
      gameId,
      action: "abort",
      expectedVersion: snapshot.version,
      commandId: crypto.randomUUID(),
    },
  });
  expect(stopped.status()).toBe(200);
  await page.goto(`/games/${gameId}`);
  await page.getByRole("tab", { name: "Moves", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Moves", exact: true });
  const history = page.getByRole("region", { name: "Move history", exact: true });
  await expect(history.getByRole("button", { name: /^View ply/ })).toHaveCount(32);
  const transition = await expectArenaTransition(page);
  for (const enlarged of [false, true]) {
    await page.evaluate((large) => {
      document.documentElement.style.fontSize = large ? "200%" : "100%";
    }, enlarged);
    for (const width of [1024, 1025, transition - 1, transition, transition + 1, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const historyBounds = await bounds(history);
      expect(historyBounds.bottom).toBeLessThanOrEqual((await bounds(panel)).bottom + 1);
      expect(historyBounds.bottom).toBeLessThan(
        (await bounds(page.getByRole("link", { name: "New private room", exact: true }))).top,
      );
      await expectArenaLayout(page);
    }
  }
});

for (const mode of ["ai", "human", "room"] as const) {
  test(`${mode} route keeps board geometry and actions reachable across layouts`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    if (mode === "room") {
      await createRoom(page, "Black");
    } else {
      await createAccount(page.request);
      await page.goto("/");
      if (mode === "human") {
        await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
        await page.getByLabel("Game mode").selectOption("ai_vs_human");
        await page.getByLabel("Your color").selectOption("white");
      }
      for (const color of mode === "ai" ? (["White", "Black"] as const) : (["Black"] as const)) {
        await configureCredential(page, color, { apiKey: "slow-fixture" });
      }
      await submitGame(page);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    }
    const board = page.getByRole("grid");
    const boardNode = await board.elementHandle();
    const fen = await board.getAttribute("data-fen");
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") writes.push(new URL(request.url()).pathname);
    });
    await expectArenaTransition(page);
    for (const width of [320, 390, 768, 1024, 1025, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 600 : 900 });
      await expectArenaLayout(page);
      expect(await board.evaluate((current, original) => current === original, boardNode)).toBe(
        true,
      );
      await expect(board).toHaveAttribute("data-fen", fen!);
      const action = page.getByRole("button", {
        name: mode === "room" ? "Close room" : "Resume",
        exact: true,
      });
      await action.scrollIntoViewIfNeeded();
      await action.focus();
      await expect(action).toBeFocused();
      await expect(action).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${width}.png`), fullPage: true });
    }
    expect(writes.filter((path) => /\/(ai-turn|lifecycle|moves)$/.test(path))).toEqual([]);
  });
}

test("resizing preserves a pending promotion and its keyboard return", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  let snapshot = await startSandbox(page, touch);
  for (const move of ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2"]) {
    snapshot = await playMove(page, snapshot, move, touch);
  }
  const transition = await expectArenaTransition(page);
  const board = page.getByRole("grid");
  const boardNode = await board.elementHandle();
  await activate(square(page, "b7"), touch);
  await activate(square(page, "a8"), touch);
  const dialog = page.getByRole("dialog", { name: /Choose a piece/ });
  const dialogNode = await dialog.elementHandle();
  const knight = dialog.getByRole("button", { name: "Promote to Knight" });
  await knight.focus();
  for (const width of [transition - 1, transition, transition + 1, 320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await board.evaluate((current, original) => current === original, boardNode)).toBe(true);
    expect(await dialog.evaluate((current, original) => current === original, dialogNode)).toBe(
      true,
    );
    await expect(knight).toBeFocused();
    await expect(board).toHaveAttribute("data-fen", snapshot.fen);
  }
  expect(await readSnapshot(page, snapshot.gameId)).toEqual(snapshot);
  await page.keyboard.press("Escape");
  await expect(square(page, "a8")).toBeFocused();
  await activate(square(page, "a8"), touch);
  const accepted = page.waitForResponse(API_ORIGIN + `/games/${snapshot.gameId}/moves`);
  await knight.click();
  expect((await accepted).status()).toBe(200);
  expect((await readSnapshot(page, snapshot.gameId)).moves.at(-1)?.uci).toBe("b7a8n");
});

async function bounds(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}

test("keeps live status above the board and game controls below it", async ({ page }, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  await page.setViewportSize(touch ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
  let snapshot = await startSandbox(page, touch);
  for (const move of ["f2f3", "e7e5", "g2g4"]) {
    snapshot = await playMove(page, snapshot, move, touch);
  }
  const board = page.getByRole("grid", { name: "Chessboard" });
  const history = page.getByRole("region", { name: "Moves", exact: true });
  const controls = page.getByRole("group", { name: "Game controls" });
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const flip = page.getByRole("button", { name: "Flip board", exact: true });
  const abort = page.getByRole("button", { name: "Abort game", exact: true });
  const resignWhite = page.getByRole("button", { name: "Resign White", exact: true });
  const resignBlack = page.getByRole("button", { name: "Resign Black", exact: true });
  const help = page.getByRole("button", { name: "Keyboard controls", exact: true });
  const title = page.getByRole("heading", { name: "Sandbox", exact: true });
  const turn = page.getByRole("heading", { name: "Black to move", exact: true });
  await expect(turn).toBeVisible();
  await expect(board).toHaveAttribute("data-fen", snapshot.fen);
  await page.evaluate(() => document.fonts.ready);
  const initial = await bounds(board);
  const beforeControls = await bounds(controls);
  const beforeHistory = await bounds(history);
  async function checkButtonSizing(primary: Locator) {
    const primaryBounds = await bounds(primary);
    const flipBounds = await bounds(flip);
    const whiteBounds = await bounds(resignWhite);
    const blackBounds = await bounds(resignBlack);
    expect(Math.abs(primaryBounds.width - flipBounds.width)).toBeLessThan(1);
    expect(Math.abs(whiteBounds.width - blackBounds.width)).toBeLessThan(1);
    if (!touch) {
      const helpBounds = await bounds(help);
      expect(Math.abs(whiteBounds.top - blackBounds.top)).toBeLessThan(1);
      expect(Math.abs(blackBounds.top - helpBounds.top)).toBeLessThan(1);
      const firstGap = blackBounds.left - whiteBounds.right;
      const secondGap = helpBounds.left - blackBounds.right;
      expect(firstGap).toBeGreaterThan(0);
      expect(Math.abs(firstGap - secondGap)).toBeLessThan(1);
      for (const button of [resignWhite, resignBlack, help]) {
        const label = await button.locator(":scope > span").evaluate((element) => ({
          text: (element as HTMLElement).innerText,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        }));
        expect(
          label.height,
          `Desktop toolbar label must fit on one line: ${label.text}`,
        ).toBeLessThanOrEqual(label.lineHeight + 1);
      }
    }
  }
  await checkButtonSizing(pause);
  expect((await bounds(turn)).bottom).toBeLessThan(initial.top);
  expect((await bounds(pause)).top).toBeGreaterThan(initial.bottom);
  expect(Math.abs((await bounds(pause)).top - (await bounds(flip)).top)).toBeLessThan(1);
  if (touch) {
    expect(initial.width).toBeCloseTo(358, 0);
    expect(beforeHistory.top).toBeGreaterThan(beforeControls.bottom);
    expect((await bounds(abort)).top).toBeGreaterThan((await bounds(pause)).bottom);
  } else {
    expect(beforeHistory.left).toBeGreaterThan(initial.right);
    expect(beforeHistory.top).toBeLessThan(initial.top);
    expect(Math.abs((await bounds(pause)).top - (await bounds(abort)).top)).toBeLessThan(1);
  }
  await activate(title, touch);
  await page.screenshot({ path: testInfo.outputPath("live.png"), fullPage: true });
  await activate(pause, touch);
  await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await checkButtonSizing(resume);
  await expect(resume).toBeFocused();
  expect(Math.abs((await bounds(board)).top - initial.top)).toBeLessThan(1);
  expect(Math.abs((await bounds(controls)).top - beforeControls.top)).toBeLessThan(1);
  expect(Math.abs((await bounds(history)).top - beforeHistory.top)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath("paused.png"), fullPage: true });
  await controls.screenshot({ path: testInfo.outputPath("paused-toolbar.png") });
  await activate(flip, touch);
  await expect(board).toHaveAttribute("data-orientation", "black");
  await expect(square(page, "h1")).toHaveAccessibleName(/h1: White rook/);
  const boardNode = await board.elementHandle();
  await square(page, "e2").focus();
  await expectArenaTransition(page);
  expect(await board.evaluate((current, original) => current === original, boardNode)).toBe(true);
  await expect(board).toHaveAttribute("data-orientation", "black");
  await expect(board).toHaveAttribute("data-fen", snapshot.fen);
  await expect(square(page, "e2")).toBeFocused();
  await activate(resume, touch);
  await expect(turn).toBeVisible();
  await expect(board).toHaveAttribute("data-fen", snapshot.fen);
  await activate(help, touch);
  await expect(help).toHaveAttribute("aria-expanded", "true");
  await activate(help, touch);
  await expect(help).toHaveAttribute("aria-expanded", "false");
});
