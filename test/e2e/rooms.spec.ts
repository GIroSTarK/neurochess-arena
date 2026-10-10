import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { type MoveCommand, roomViewSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { acceptedMove, activate, expect, playMove, readSnapshot, square, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

async function createRoom(page: Page, color: "White" | "Black") {
  await createAccount(page.request);
  await page.goto("/rooms");
  await page.getByRole("radio", { name: color, exact: true }).check();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(/\/games\/[a-f0-9-]+$/);
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  const invitation = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  return { invitation, gameId: new URL(page.url()).pathname.split("/").at(-1)! };
}
async function joinRoom(page: Page, invitation: string, gameId: string) {
  await page.goto(invitation);
  await expect(page).toHaveURL(WEB_ORIGIN + "/rooms/join");
  await expect(page.getByRole("grid")).toHaveCount(0);
  await page.getByRole("button", { name: "Join as guest", exact: true }).click();
  await expect(page).toHaveURL(WEB_ORIGIN + "/games/" + gameId);
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
}
async function confirm(page: Page, label: string, confirmLabel: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
}
async function room(page: Page, gameId: string) {
  return roomViewSchema.parse(
    await (await page.request.get(API_ORIGIN + "/rooms/" + gameId)).json(),
  );
}

test("a dropped native socket resynchronizes both seats without pausing or losing the latest move", async ({
  page,
  newContext,
}) => {
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.assign(window, { roomTestSockets: sockets });
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
  const { invitation, gameId } = await createRoom(page, "White");
  const guest = await (await newContext()).newPage();
  await joinRoom(guest, invitation, gameId);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await playMove(page, await readSnapshot(page, gameId), "e2e4", false);
  const oldCount = await page.evaluate(() => {
    const sockets = (window as unknown as { roomTestSockets: WebSocket[] }).roomTestSockets;
    sockets.at(-1)!.close();
    return sockets.length;
  });
  await expect(guest.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await playMove(guest, await readSnapshot(guest, gameId), "e7e5", false);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { roomTestSockets: WebSocket[] }).roomTestSockets.length,
      ),
    )
    .toBeGreaterThan(oldCount);
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await expect(page.getByRole("status")).toContainText("e5");
  expect((await readSnapshot(page, gameId)).state).toBe("active");
  expect((await readSnapshot(page, gameId)).moves.map((move) => move.uci)).toEqual([
    "e2e4",
    "e7e5",
  ]);
});

test("Black owner and guest White complete a public UI game, replay and download matching private PGN", async ({
  page,
  newContext,
}, testInfo) => {
  const forbidden: string[] = [];
  const inspect = (url: string) => {
    if (
      url.startsWith(API_ORIGIN + "/") &&
      /\/(?:credentials|providers|ai-turn|controller|invocations)(?:\/|$)/.test(url)
    ) {
      forbidden.push(new URL(url).pathname);
    }
  };
  page.on("request", (request) => inspect(request.url()));
  const { invitation, gameId } = await createRoom(page, "Black");
  const touch = testInfo.project.name === "mobile-touch";
  const guest = await (
    await newContext({
      hasTouch: touch,
      isMobile: touch,
      viewport: testInfo.project.use.viewport ?? null,
    })
  ).newPage();
  guest.on("request", (request) => inspect(request.url()));
  await joinRoom(guest, invitation, gameId);
  await expect(page.getByRole("grid").locator("[data-square]").first()).toHaveAttribute(
    "data-square",
    "h1",
  );
  await expect(guest.getByRole("grid").locator("[data-square]").first()).toHaveAttribute(
    "data-square",
    "a8",
  );
  await expect(guest.getByRole("button", { name: "Close room", exact: true })).toHaveCount(0);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  const line = ["f2f3", "e7e5", "g2g4", "d8h4"];
  for (let index = 0; index < line.length; index++) {
    const player = index % 2 === 0 ? guest : page;
    const move = line[index]!;
    await expect(player.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    const before = await readSnapshot(player, gameId);
    if (!touch && index === 0) {
      await square(player, "f2").focus();
      await player.keyboard.press("Space");
      await player.keyboard.press("ArrowUp");
      const response = player.waitForResponse((response) =>
        response.url().endsWith(`/games/${gameId}/moves`),
      );
      await player.keyboard.press("Enter");
      await acceptedMove(await response, before, move, player);
    } else await playMove(player, before, move, touch);
    await expect((index % 2 === 0 ? page : guest).getByRole("status")).toContainText(
      (await readSnapshot(player, gameId)).moves.at(-1)!.san,
    );
  }
  for (const player of [page, guest]) {
    await expect(player.getByRole("heading", { name: "Black wins", exact: true })).toBeVisible();
    await player.getByRole("button", { name: "First", exact: true }).click();
    await expect(player.getByText("Ply 0 of 4", { exact: true })).toBeVisible();
    await player.getByRole("button", { name: "Last", exact: true }).click();
    await expect(player.getByText("Ply 4 of 4", { exact: true })).toBeVisible();
  }
  const final = await readSnapshot(page, gameId);
  expect(await readSnapshot(guest, gameId)).toEqual(final);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PGN", exact: true }).click();
  const downloadPath = await (await download).path();
  if (!downloadPath) throw new Error("Expected a PGN download");
  expect(await readFile(downloadPath, "utf8")).toBe(final.pgn);
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.locator(`a[href="/games/${gameId}"]`).click();
  await expect(page.getByRole("heading", { name: "Black wins", exact: true })).toBeVisible();
  expect(forbidden).toEqual([]);
});

test("two human seats promote explicitly, cancel safely and resign only their own color", async ({
  page,
  newContext,
}, testInfo) => {
  const { invitation, gameId } = await createRoom(page, "White");
  const touch = testInfo.project.name === "mobile-touch";
  const guest = await (
    await newContext({
      hasTouch: touch,
      isMobile: touch,
      viewport: testInfo.project.use.viewport ?? null,
    })
  ).newPage();
  await joinRoom(guest, invitation, gameId);
  const line = ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2"];
  for (let index = 0; index < line.length; index++) {
    const player = index % 2 === 0 ? page : guest;
    await expect(player.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await playMove(player, await readSnapshot(player, gameId), line[index]!, touch);
  }
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  const before = await readSnapshot(page, gameId);
  await activate(square(page, "b7"), touch);
  await activate(square(page, "a8"), touch);
  await expect(page.getByRole("dialog", { name: /Choose a piece/ })).toBeVisible();
  expect(await readSnapshot(page, gameId)).toEqual(before);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(square(page, "a8")).toBeFocused();
  await activate(square(page, "a8"), touch);
  const response = page.waitForResponse((response) =>
    response.url().endsWith(`/games/${gameId}/moves`),
  );
  await activate(page.getByRole("button", { name: "Promote to Knight", exact: true }), touch);
  await acceptedMove(await response, before, "b7a8n", page);
  await expect(guest.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await playMove(guest, await readSnapshot(guest, gameId), "g2h1r", touch);
  await confirm(guest, "Resign", "Confirm resignation");
  await expect(page.getByRole("heading", { name: "White wins", exact: true })).toBeVisible();
  expect((await readSnapshot(page, gameId)).terminationReason).toBe("human_resignation");
});

test("uncertain human moves freeze submissions and explicit retry reuses the command receipt", async ({
  page,
  newContext,
}, testInfo) => {
  const { invitation, gameId } = await createRoom(page, "White");
  const guest = await (await newContext()).newPage();
  await joinRoom(guest, invitation, gameId);
  const commands: MoveCommand[] = [];
  await page.route(API_ORIGIN + `/games/${gameId}/moves`, async (route) => {
    commands.push(route.request().postDataJSON() as MoveCommand);
    if (commands.length === 1) {
      await route.fulfill({ status: 200, json: { acknowledgement: "lost" } });
    } else await route.continue();
  });
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  const touch = testInfo.project.name === "mobile-touch";
  await activate(square(page, "e2"), touch);
  await activate(square(page, "e4"), touch);
  await expect(page.getByRole("button", { name: "Retry same move", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  expect((await readSnapshot(page, gameId)).moves).toHaveLength(0);
  await page.getByRole("button", { name: "Retry same move", exact: true }).click();
  await expect(guest.getByRole("status")).toContainText("e4");
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await guest.route(API_ORIGIN + `/games/${gameId}/moves`, async (route) => {
    await route.fetch();
    await route.fulfill({ status: 200, json: { acknowledgement: "lost after commit" } });
  });
  await expect(guest.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await square(guest, "e7").click();
  await square(guest, "e5").click();
  await expect(page.getByRole("status")).toContainText("e5");
  await expect(guest.getByRole("button", { name: "Retry same move", exact: true })).toHaveCount(0);
  expect((await readSnapshot(page, gameId)).moves.map((move) => move.uci)).toEqual([
    "e2e4",
    "e7e5",
  ]);
});

test("offline opponent and refresh preserve active play, owner closure restores terminal replay on return", async ({
  page,
  newContext,
}) => {
  const { invitation, gameId } = await createRoom(page, "White");
  const guest = await (await newContext()).newPage();
  await joinRoom(guest, invitation, gameId);
  await guest.goto("about:blank");
  await expect(page.locator('[data-seat="black"]')).toContainText("Offline");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await playMove(page, await readSnapshot(page, gameId), "e2e4", false);
  await page.reload();
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  expect((await readSnapshot(page, gameId)).state).toBe("active");
  await page.getByRole("link", { name: "Private rooms", exact: true }).click();
  await page.getByRole("link", { name: "Return to your unfinished game", exact: true }).click();
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  await confirm(page, "Close room", "Confirm close");
  await guest.goto(`/games/${gameId}`);
  await expect(guest.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
  await expect(guest.getByRole("button", { name: "Download PGN", exact: true })).toBeVisible();
  expect((await room(page, gameId)).snapshot).toEqual((await room(guest, gameId)).snapshot);
});

test("live guest identity switches clear the old room and cannot take its seat", async ({
  page,
  newContext,
  expectedGame404s,
}) => {
  const { invitation, gameId } = await createRoom(page, "White");
  const guest = await (await newContext()).newPage();
  await joinRoom(guest, invitation, gameId);
  await createAccount(guest.request);
  expectedGame404s.set(guest, new Set([API_ORIGIN + `/games/${gameId}/details`]));
  await guest.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(guest.getByRole("grid")).toHaveCount(0);
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  expect((await readSnapshot(page, gameId)).state).toBe("active");
});

test("room controls, live announcements and expanded text stay accessible on desktop and mobile", async ({
  page,
  newContext,
}, testInfo) => {
  const { invitation, gameId } = await createRoom(page, "Black");
  const guest = await (await newContext()).newPage();
  await joinRoom(guest, invitation, gameId);
  await expect(page.getByRole("button", { name: "Resign", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  expect((await new AxeBuilder({ page }).include("#room-game").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Close room", exact: true }).focus();
  await playMove(guest, await readSnapshot(guest, gameId), "e2e4", false);
  await expect(page.getByRole("button", { name: "Close room", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("room-live.png"), fullPage: true });
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: /^Resign/ }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /^Close room/ })).toBeFocused();
    await expect(page.getByRole("button", { name: /^Close room/ })).toBeInViewport();
  }
});
