import { randomUUID } from "node:crypto";

import {
  authSessionResponseSchema,
  gameSnapshotSchema,
  roomCreationOperationSchema,
  roomIssuedResponseSchema,
  roomServerMessageSchema,
  roomViewSchema,
} from "@neurochess/contracts";
import type { JSHandle, Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";

async function post(page: Page, path: string, body: object) {
  return page.evaluate(
    async ({ url, body }) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    { url: API_ORIGIN + path, body },
  );
}

async function read(page: Page, path: string) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "include" });
    return { status: response.status, body: (await response.json()) as unknown };
  }, API_ORIGIN + path);
}

async function subscribe(page: Page, gameId: string) {
  const session = authSessionResponseSchema.parse((await read(page, "/api/auth/get-session")).body);
  return page.evaluateHandle(
    ({ url, gameId, expectedIdentity }) =>
      new Promise<{ socket: WebSocket; messages: unknown[] }>((resolve, reject) => {
        const socket = new WebSocket(url);
        const messages: unknown[] = [];
        socket.onmessage = (event) => {
          messages.push(JSON.parse(String(event.data)));
        };
        socket.onerror = () => reject(new Error("Room socket failed"));
        socket.onopen = () => {
          socket.send(JSON.stringify({ protocol: 1, type: "subscribe", gameId, expectedIdentity }));
          resolve({ socket, messages });
        };
      }),
    {
      url: API_ORIGIN.replace(/^http/, "ws") + "/rooms/realtime",
      gameId,
      expectedIdentity: session?.user.id ?? "guest",
    },
  );
}

async function socketRoom(
  client: JSHandle<{ socket: WebSocket; messages: unknown[] }>,
  version: number,
) {
  const latest = async () => {
    const frames = await client.evaluate(({ messages }) => messages);
    return frames
      .map((message) => roomServerMessageSchema.parse(message))
      .filter((message) => "room" in message)
      .at(-1);
  };
  await expect
    .poll(async () => {
      const frame = await latest();
      return frame && "room" in frame ? frame.room.snapshot.version : null;
    })
    .toBe(version);
  const frame = await latest();
  if (!frame || !("room" in frame)) throw new Error("Expected a private room frame");
  return frame.room;
}

async function closeSocket(client: JSHandle<{ socket: WebSocket; messages: unknown[] }>) {
  await client.evaluate(
    ({ socket }) =>
      new Promise<void>((resolve) => {
        socket.onclose = () => resolve();
        socket.close();
      }),
  );
  await client.dispose();
}

async function socketPresence(
  client: JSHandle<{ socket: WebSocket; messages: unknown[] }>,
  online: { white: boolean; black: boolean },
) {
  await expect
    .poll(async () => {
      const messages = await client.evaluate(({ messages }) => messages);
      return messages
        .map((message) => roomServerMessageSchema.parse(message))
        .filter((message) => message.type === "presence")
        .at(-1)?.online;
    })
    .toEqual(online);
}

test("two browser identities complete a private HTTP room with a Black owner and guest White", async ({
  page,
  newContext,
}) => {
  await createAccount(page.request);
  await page.goto("/account");
  const guestContext = await newContext();
  const guest = await guestContext.newPage();
  await guest.goto("/");
  const operationResult = await post(page, "/rooms/creation-operation", {});
  expect(operationResult.status).toBe(200);
  const operation = roomCreationOperationSchema.parse(operationResult.body);
  const creation = { operationId: operation.operationId, ownerColor: "black" };
  const created = await post(page, "/rooms", creation);
  expect(created.status).toBe(200);
  const { room, invitation } = roomIssuedResponseSchema.parse(created.body);
  const gameId = room.snapshot.gameId;
  const ownerSocket = await subscribe(page, gameId);
  expect(await socketRoom(ownerSocket, 0)).toEqual(room);
  expect((await guest.request.get(API_ORIGIN + `/rooms/${gameId}`)).status()).toBe(401);
  expect((await post(guest, "/rooms/invitations/resolve", { invitation })).body).toEqual({
    status: "joinable",
  });
  expect((await guestContext.cookies()).some((cookie) => cookie.name.includes("guest"))).toBe(
    false,
  );
  expect((await post(guest, "/guest-session", {})).status).toBe(200);
  const join = { invitation, commandId: randomUUID() };
  const admitted = await post(guest, "/rooms/join", join);
  expect(admitted.status).toBe(200);
  let snapshot = roomViewSchema.parse(admitted.body).snapshot;
  const guestSocket = await subscribe(guest, gameId);
  expect((await socketRoom(ownerSocket, 1)).viewer).toEqual({ color: "black", isOwner: true });
  expect((await socketRoom(guestSocket, 1)).capabilities).toMatchObject({
    canMove: true,
    canClose: false,
  });
  expect((await post(guest, "/rooms/join", join)).body).toEqual(admitted.body);
  expect(
    roomIssuedResponseSchema.parse((await post(page, "/rooms", creation)).body).invitation,
  ).toBeNull();
  for (const move of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
    const player = snapshot.turn === "white" ? guest : page;
    const accepted = await post(player, `/games/${gameId}/moves`, {
      gameId,
      expectedVersion: snapshot.version,
      commandId: randomUUID(),
      move,
    });
    expect(accepted.status).toBe(200);
    snapshot = gameSnapshotSchema.parse(accepted.body);
    for (const socket of [ownerSocket, guestSocket]) {
      expect((await socketRoom(socket, snapshot.version)).snapshot).toEqual(snapshot);
    }
  }
  expect(snapshot).toMatchObject({
    state: "completed",
    result: "0-1",
    terminationReason: "checkmate",
  });
  for (const player of [page, guest]) {
    expect(roomViewSchema.parse((await read(player, `/rooms/${gameId}`)).body).snapshot).toEqual(
      snapshot,
    );
    expect((await read(player, `/games/${gameId}/pgn`)).body).toEqual({
      gameId,
      version: snapshot.version,
      pgn: snapshot.pgn,
    });
    expect(player.url()).not.toContain(invitation!);
    expect(
      await player.evaluate(() =>
        JSON.stringify({
          local: Object.entries(localStorage),
          session: Object.entries(sessionStorage),
        }),
      ),
    ).not.toContain(invitation!);
  }
  expect((await post(guest, "/rooms/invitations/resolve", { invitation })).body).toEqual({
    status: "unavailable",
  });
  await Promise.all([closeSocket(ownerSocket), closeSocket(guestSocket)]);
  await page.goto("/history");
  await expect(page.getByText("Guest player", { exact: true })).toBeVisible();
});

test("two account browsers preserve private history when the owner closes an HTTP room", async ({
  page,
  newContext,
}) => {
  const owner = await createAccount(page.request);
  await page.goto("/account");
  const other = await (await newContext()).newPage();
  const opponent = await createAccount(other.request);
  await other.goto("/account");
  const operation = roomCreationOperationSchema.parse(
    (await post(page, "/rooms/creation-operation", {})).body,
  );
  const { room, invitation } = roomIssuedResponseSchema.parse(
    (await post(page, "/rooms", { operationId: operation.operationId, ownerColor: "white" })).body,
  );
  const gameId = room.snapshot.gameId;
  const joined = await post(other, "/rooms/join", { invitation, commandId: randomUUID() });
  expect(joined.status).toBe(200);
  const ownerSocket = await subscribe(page, gameId);
  const opponentSocket = await subscribe(other, gameId);
  for (const socket of [ownerSocket, opponentSocket]) await socketRoom(socket, 1);
  await socketPresence(ownerSocket, { white: true, black: true });
  const command = { gameId, expectedVersion: 1, commandId: randomUUID(), action: "abort" };
  expect(
    (
      await other.request.post(API_ORIGIN + `/games/${gameId}/lifecycle`, {
        headers: { origin: WEB_ORIGIN },
        data: command,
      })
    ).status(),
  ).toBe(403);
  await closeSocket(opponentSocket);
  await socketPresence(ownerSocket, { white: true, black: false });
  expect((await post(page, `/games/${gameId}/lifecycle`, command)).status).toBe(200);
  const restoredOpponent = await subscribe(other, gameId);
  for (const socket of [ownerSocket, restoredOpponent]) {
    expect((await socketRoom(socket, 2)).snapshot.state).toBe("aborted");
  }
  await Promise.all([closeSocket(ownerSocket), closeSocket(restoredOpponent)]);
  await other.reload();
  expect(roomViewSchema.parse((await read(other, `/rooms/${gameId}`)).body).snapshot.state).toBe(
    "aborted",
  );
  for (const player of [page, other]) {
    await player.goto("/history");
    await expect(player.getByText(owner.username, { exact: true }).first()).toBeVisible();
    await expect(player.getByText(opponent.username, { exact: true }).first()).toBeVisible();
  }
});

test("native room sockets aggregate tabs and resynchronize after both browsers disconnect", async ({
  page,
  newContext,
}) => {
  await createAccount(page.request);
  await page.goto("/account");
  const secondTab = await page.context().newPage();
  await secondTab.goto("/account");
  const guest = await (await newContext()).newPage();
  await guest.goto("/");
  const operation = roomCreationOperationSchema.parse(
    (await post(page, "/rooms/creation-operation", {})).body,
  );
  const { room, invitation } = roomIssuedResponseSchema.parse(
    (await post(page, "/rooms", { operationId: operation.operationId, ownerColor: "white" })).body,
  );
  const gameId = room.snapshot.gameId;
  expect((await post(guest, "/guest-session", {})).status).toBe(200);
  expect((await post(guest, "/rooms/join", { invitation, commandId: randomUUID() })).status).toBe(
    200,
  );
  const first = await subscribe(page, gameId);
  const second = await subscribe(secondTab, gameId);
  const observer = await subscribe(guest, gameId);
  for (const socket of [first, second, observer]) await socketRoom(socket, 1);
  await socketPresence(observer, { white: true, black: true });
  await closeSocket(first);
  const revisionCount = await observer.evaluate(
    ({ messages }) =>
      messages.filter((message) => (message as { type: string }).type === "revision").length,
  );
  await expect
    .poll(() =>
      observer.evaluate(
        ({ messages }) =>
          messages.filter((message) => (message as { type: string }).type === "revision").length,
      ),
    )
    .toBeGreaterThan(revisionCount);
  await socketPresence(observer, { white: true, black: true });
  await closeSocket(second);
  await socketPresence(observer, { white: false, black: true });
  await closeSocket(observer);
  await page.reload();
  const returned = await subscribe(page, gameId);
  expect((await socketRoom(returned, 1)).snapshot.state).toBe("active");
  await socketPresence(returned, { white: true, black: false });
  const accepted = await post(page, `/games/${gameId}/moves`, {
    gameId,
    expectedVersion: 1,
    commandId: randomUUID(),
    move: "e2e4",
  });
  expect(accepted.status).toBe(200);
  await guest.reload();
  const opponent = await subscribe(guest, gameId);
  expect((await socketRoom(opponent, 2)).snapshot).toEqual(gameSnapshotSchema.parse(accepted.body));
  await socketPresence(returned, { white: true, black: true });
  await Promise.all([closeSocket(returned), closeSocket(opponent)]);
  await secondTab.close();
});
