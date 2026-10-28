import type { WebSocketRoute } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { API_ORIGIN } from "./environment";
import { expect, playMove, readSnapshot, square, test } from "./fixtures";
import { confirm, createRoom, expectSharedResult, joinRoom, playRoomLine } from "./room-helpers";

test("persistent socket failure offers near-board reconnect without changing room authority", async ({
  page,
  newContext,
}) => {
  let blocked = false;
  let connection: WebSocketRoute | undefined;
  await page.routeWebSocket(API_ORIGIN.replace(/^http/, "ws") + "/rooms/realtime", (route) => {
    connection = route;
    if (blocked) void route.close();
    else route.connectToServer();
  });
  const { invitation, gameId } = await createRoom(page, "White");
  const opponent = await (await newContext()).newPage();
  await joinRoom(opponent, invitation, gameId);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  const before = await readSnapshot(page, gameId);
  blocked = true;
  await connection!.close();
  const play = page.getByRole("region", { name: "Play area", exact: true });
  await expect(play.getByTestId("room-connection")).toContainText("Connection unavailable", {
    timeout: 25_000,
  });
  await expect(play.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", before.fen);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  for (const action of ["Resign", "Close room"]) {
    await expect(play.getByRole("button", { name: action, exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }
  blocked = false;
  await play.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(play.getByTestId("room-connection")).toHaveText("Room connected");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  expect(await readSnapshot(page, gameId)).toEqual(before);
  await playMove(page, before, "e2e4", false);
  await expect(opponent.getByRole("status")).toContainText("e4");
});

test("both account browsers recover multiple moves after every tab disconnects without changing the game", async ({
  page,
  newContext,
  browserName,
}, testInfo) => {
  // Six full document loads across three pages exceed a single-flow budget in Firefox.
  if (browserName === "firefox") test.setTimeout(90_000);
  const { invitation, gameId } = await createRoom(page, "White");
  const touch = Boolean(testInfo.project.use.hasTouch);
  const opponent = await (
    await newContext({
      hasTouch: touch,
      isMobile: touch,
      viewport: testInfo.project.use.viewport ?? null,
    })
  ).newPage();
  await createAccount(opponent.request);
  await joinRoom(opponent, invitation, gameId, "account");
  const snapshot = await playRoomLine(
    page,
    opponent,
    gameId,
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"],
    touch,
  );
  const duplicate = await page.context().newPage();
  await duplicate.goto(`/games/${gameId}`);
  await expect(duplicate.getByTestId("room-connection")).toHaveText("Room connected");
  await page.goto("about:blank");
  await expect(opponent.locator('[data-seat="white"]')).toContainText("Online");
  await duplicate.close();
  await expect(opponent.locator('[data-seat="white"]')).toContainText("Offline");
  await opponent.goto("about:blank");
  expect(await readSnapshot(page, gameId)).toEqual(snapshot);
  for (const player of [page, opponent]) {
    await player.goto(`/games/${gameId}`);
    await expect(player.getByTestId("room-connection")).toHaveText("Room connected");
    await expect(player.getByRole("status")).toContainText("Nf6");
    expect(await readSnapshot(player, gameId)).toEqual(snapshot);
    await expect(player.getByRole("button", { name: /^(Pause|Resume)$/ })).toHaveCount(0);
  }
  await page.reload();
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  await playRoomLine(page, opponent, gameId, ["d2d3", "f8c5"], touch);
  await confirm(page, "Resign", "Confirm resignation");
  const final = await readSnapshot(page, gameId);
  expect(final).toMatchObject({
    state: "completed",
    result: "0-1",
    terminationReason: "human_resignation",
  });
  await expectSharedResult([page, opponent], final, "Black wins");
});

test("delayed HTTP acknowledgement and duplicate older socket events cannot roll back newer moves or a terminal result", async ({
  page,
  newContext,
}) => {
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    let earlyState: string | undefined;
    Object.assign(window, {
      replayEarlyRoomUpdate() {
        const socket = sockets.findLast((socket) => socket.readyState === WebSocket.OPEN);
        if (!socket) throw new Error("No live room socket at frame replay");
        if (!earlyState) {
          throw new Error("No one-move snapshot or update captured before frame replay");
        }
        socket.dispatchEvent(new MessageEvent("message", { data: earlyState }));
      },
    });
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        this.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            room?: { snapshot: { moves: unknown[] } };
          };
          // Reconciliation can deliver the accepted move as a full snapshot.
          if (
            (message.type === "snapshot" || message.type === "update") &&
            message.room?.snapshot.moves.length === 1
          ) {
            earlyState = String(event.data);
          }
        });
      }
    };
  });
  const replayEarlyUpdate = () =>
    page.evaluate(async () => {
      (window as unknown as { replayEarlyRoomUpdate: () => void }).replayEarlyRoomUpdate();
      await new Promise(requestAnimationFrame);
      return document.querySelector('[role="grid"]')?.getAttribute("data-fen");
    });
  const { invitation, gameId } = await createRoom(page, "Black");
  const opponent = await (await newContext()).newPage();
  await createAccount(opponent.request);
  await joinRoom(opponent, invitation, gameId, "account");
  await playRoomLine(opponent, page, gameId, ["f2f3"]);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    API_ORIGIN + `/games/${gameId}/moves`,
    async (route) => {
      const response = await route.fetch();
      await barrier;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await square(page, "e7").click();
    await square(page, "e5").click();
    await expect(opponent.getByRole("status")).toContainText("e5");
    await expect(opponent.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await playMove(opponent, await readSnapshot(opponent, gameId), "g2g4", false);
    await expect(page.getByRole("status")).toContainText("g4");
    const afterG4 = await readSnapshot(page, gameId);
    expect(await replayEarlyUpdate()).toBe(afterG4.fen);
    expect(await replayEarlyUpdate()).toBe(afterG4.fen);
    release();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await expect(page.getByRole("status")).toContainText("g4");
    await expect(square(page, "g4").locator('[data-piece="white-p"]')).toBeVisible();
    await playMove(page, await readSnapshot(page, gameId), "d8h4", false);
    const final = await readSnapshot(page, gameId);
    await expectSharedResult([page, opponent], final, "Black wins");
    expect(await replayEarlyUpdate()).toBe(final.fen);
    await expect(page.getByRole("heading", { name: "Black wins", exact: true })).toBeVisible();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    expect((await readSnapshot(page, gameId)).moves.map((move) => move.uci)).toEqual([
      "f2f3",
      "e7e5",
      "g2g4",
      "d8h4",
    ]);
  } finally {
    release();
  }
});

test("a lost post-commit acknowledgement with a disconnected socket synchronizes before accepting another move", async ({
  page,
  newContext,
}) => {
  let blocked = false;
  let connection: WebSocketRoute | undefined;
  await page.routeWebSocket(API_ORIGIN.replace(/^http/, "ws") + "/rooms/realtime", (route) => {
    connection = route;
    if (!blocked) route.connectToServer();
  });
  const { invitation, gameId } = await createRoom(page, "White");
  const opponent = await (await newContext()).newPage();
  await joinRoom(opponent, invitation, gameId);
  let commands = 0;
  await page.route(API_ORIGIN + `/games/${gameId}/moves`, async (route) => {
    commands++;
    blocked = true;
    await connection!.close();
    expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 200, json: { acknowledgement: "lost after commit" } });
  });
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await square(page, "e2").click();
  await square(page, "e4").click();
  await expect(opponent.getByRole("status")).toContainText("e4");
  await expect(page.getByTestId("room-connection")).not.toHaveText("Room connected");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  const play = page.getByRole("region", { name: "Play area", exact: true });
  await expect(play.getByTestId("room-connection")).not.toHaveText("Room connected");
  await expect(play.getByRole("button", { name: "Retry same move", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry same move", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(commands).toBe(1);
  blocked = false;
  await connection!.close();
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  await expect(page.getByRole("status")).toContainText("e4");
  await expect(page.getByRole("button", { name: "Retry same move", exact: true })).toHaveCount(0);
  await playRoomLine(page, opponent, gameId, ["e7e5"]);
  expect(commands).toBe(1);
  expect((await readSnapshot(page, gameId)).moves.map((move) => move.uci)).toEqual([
    "e2e4",
    "e7e5",
  ]);
});
