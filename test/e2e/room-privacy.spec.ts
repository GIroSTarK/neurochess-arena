import { randomUUID } from "node:crypto";

import { authSessionResponseSchema, roomServerMessageSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { observeCredentialPrivacy } from "./credential-privacy";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, playMove, readSnapshot, startSandbox, test } from "./fixtures";
import { confirm, createRoom, expectSharedResult, joinRoom, playRoomLine } from "./room-helpers";

const headers = { origin: WEB_ORIGIN };

test("both room participants retain their public slot across AI modes while Sandbox stays independent", async ({
  page,
  newContext,
}, testInfo) => {
  const { invitation, gameId } = await createRoom(page, "White");
  const touch = Boolean(testInfo.project.use.hasTouch);
  const opponent = await (
    await newContext({
      hasTouch: touch,
      isMobile: touch,
      viewport: testInfo.project.use.viewport ?? null,
    })
  ).newPage();
  await joinRoom(opponent, invitation, gameId);
  const snapshot = await readSnapshot(page, gameId);
  for (const player of [page, opponent]) {
    for (const mode of ["ai_vs_ai", "ai_vs_human"] as const) {
      const ai = { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} };
      const response = await player.request.post(API_ORIGIN + "/games", {
        headers,
        data: { mode, seats: { white: mode === "ai_vs_ai" ? ai : { type: "human" }, black: ai } },
      });
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: snapshot,
      });
    }
    await player.goto("/");
    await player.getByRole("button", { name: "Return to game", exact: true }).click();
    await expect(player).toHaveURL(WEB_ORIGIN + `/games/${gameId}`);
    const sandbox = await startSandbox(player, touch);
    expect(sandbox.gameId).not.toBe(gameId);
    await playMove(player, sandbox, "e2e4", touch);
    expect(await readSnapshot(player, gameId)).toEqual(snapshot);
    await player.goto(`/games/${gameId}`);
    await expect(player.getByTestId("room-connection")).toHaveText("Room connected");
    await expect(player.getByRole("grid")).toHaveAttribute("data-fen", snapshot.fen);
  }
  await confirm(page, "Close room", "Confirm close");
  await expectSharedResult([page, opponent], await readSnapshot(page, gameId), "Game stopped");
});

async function expectNoPrivateReads(page: Page, gameId: string) {
  for (const path of [
    `/rooms/${gameId}`,
    ...["", "/details", "/replay", "/pgn"].map((suffix) => `/games/${gameId}${suffix}`),
  ]) {
    const response = await page.request.get(API_ORIGIN + path);
    expect(response.status()).toBe(404);
    const body: unknown = await response.json();
    for (const key of ["snapshot", "currentSnapshot", "room", "fen", "pgn"]) {
      expect(body).not.toHaveProperty(key);
    }
  }
}

async function expectNoSubscription(page: Page, gameId: string) {
  const session = authSessionResponseSchema.parse(
    await (await page.request.get(API_ORIGIN + "/api/auth/get-session")).json(),
  );
  const result = await page.evaluate(
    ({ url, gameId, expectedIdentity }) =>
      new Promise<{ messages: unknown[]; code: number }>((resolve) => {
        const socket = new WebSocket(url);
        const messages: unknown[] = [];
        socket.onopen = () =>
          socket.send(JSON.stringify({ protocol: 1, type: "subscribe", gameId, expectedIdentity }));
        socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
        socket.onclose = (event) => resolve({ messages, code: event.code });
      }),
    {
      url: API_ORIGIN.replace(/^http/, "ws") + "/rooms/realtime",
      gameId,
      expectedIdentity: session?.user.id ?? "guest",
    },
  );
  expect(result.code).toBe(1008);
  expect(result.messages.map((message) => roomServerMessageSchema.parse(message))).toEqual([
    { protocol: 1, type: "access_lost" },
  ]);
}

test("an invitation or game URL never grants an outsider a snapshot, event, history, replay or third seat", async ({
  page,
  newContext,
  expectedGame404s,
}) => {
  const { invitation, gameId } = await createRoom(page, "Black");
  const token = new URL(invitation).hash.slice("#invite=".length);
  const participant = await (await newContext()).newPage();
  const ownerPrivacy = observeCredentialPrivacy(page, [token]);
  const participantPrivacy = observeCredentialPrivacy(participant, [token]);
  await joinRoom(participant, invitation, gameId);
  const outsiders: Page[] = [];
  for (const kind of ["guest", "account"] as const) {
    const outsider = await (await newContext()).newPage();
    outsiders.push(outsider);
    if (kind === "account") await createAccount(outsider.request);
    else {
      expect(
        (
          await outsider.request.post(API_ORIGIN + "/guest-session", { headers, data: {} })
        ).status(),
      ).toBe(200);
      for (const [path, data] of [
        ["/rooms/creation-operation", {}],
        ["/rooms", { operationId: randomUUID(), ownerColor: "white" }],
      ] as const) {
        expect((await outsider.request.post(API_ORIGIN + path, { headers, data })).status()).toBe(
          401,
        );
      }
    }
    const privacy = observeCredentialPrivacy(outsider, [token]);
    await outsider.goto(invitation);
    await expect(
      outsider.getByText("This invitation is unavailable. Ask the owner for a new one."),
    ).toBeVisible();
    await expect(outsider.getByRole("grid")).toHaveCount(0);
    expect(
      (
        await outsider.request.post(API_ORIGIN + "/rooms/join", {
          headers,
          data: { invitation: token, commandId: randomUUID() },
        })
      ).status(),
    ).toBe(409);
    await expectNoPrivateReads(outsider, gameId);
    await expectNoSubscription(outsider, gameId);
    const history = await outsider.request.get(API_ORIGIN + "/games/history");
    if (kind === "guest") expect(history.status()).toBe(401);
    else {
      expect(history.status()).toBe(200);
      expect(JSON.stringify(await history.json()).includes(gameId)).toBe(false);
    }
    expectedGame404s.set(outsider, new Set([API_ORIGIN + `/games/${gameId}/details`]));
    await outsider.goto(`/games/${gameId}`);
    await expect(outsider.getByRole("status")).toContainText(
      "This private game is unavailable to your session.",
    );
    await expect(outsider.getByRole("grid")).toHaveCount(0);
    await privacy();
  }
  await playRoomLine(participant, page, gameId, ["e2e4", "e7e5"]);
  await confirm(page, "Close room", "Confirm close");
  await expectSharedResult([page, participant], await readSnapshot(page, gameId), "Game stopped");
  for (const outsider of outsiders) {
    await expectNoPrivateReads(outsider, gameId);
    await expectNoSubscription(outsider, gameId);
  }
  await ownerPrivacy();
  await participantPrivacy();
});

for (const action of ["individual", "clear"] as const) {
  test(`${action} history deletion removes only the requesting participant's room access and preserves credentials`, async ({
    page,
    newContext,
    expectedGame404s,
  }) => {
    const { invitation, gameId, owner } = await createRoom(page, "White");
    const opponent = await (await newContext()).newPage();
    const account = await createAccount(opponent.request);
    await joinRoom(opponent, invitation, gameId, "account");
    const key = "room-retention-credential-canary";
    const credentialId = randomUUID();
    const privacy = observeCredentialPrivacy(page, [key, new URL(invitation).hash.slice(8)]);
    expect(
      (
        await page.request.post(API_ORIGIN + "/credentials", {
          headers,
          data: {
            credentialId,
            provider: "openai",
            label: "Room retention",
            apiKey: key,
            save: true,
          },
        })
      ).status(),
    ).toBe(201);
    await playRoomLine(page, opponent, gameId, ["e2e4", "e7e5"]);
    await confirm(opponent, "Resign", "Confirm resignation");
    const final = await readSnapshot(page, gameId);
    expect(final).toMatchObject({
      state: "completed",
      result: "1-0",
      terminationReason: "human_resignation",
    });
    await expectSharedResult([page, opponent], final, "White wins");
    for (const player of [page, opponent]) {
      await player.goto("/history");
      const list = player.getByRole("list", { name: "Finished games" });
      await expect(list.getByText(owner.username, { exact: true })).toBeVisible();
      await expect(list.getByText(account.username, { exact: true })).toBeVisible();
    }
    await page
      .getByRole("button", {
        name: action === "clear" ? "Clear history" : /Delete game ·/,
        exact: action === "clear",
      })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(dialog).toContainText(/other participants? keep/i);
    await dialog
      .getByRole("button", {
        name: action === "clear" ? "Clear history" : "Delete game",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
    ).toHaveCount(0);
    await expectNoPrivateReads(page, gameId);
    await expectNoSubscription(page, gameId);
    expectedGame404s.set(page, new Set([API_ORIGIN + `/games/${gameId}/details`]));
    await page.goto(`/games/${gameId}`);
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      "This private game is unavailable to your session.",
    );
    await opponent.getByRole("button", { name: "Refresh history", exact: true }).click();
    await opponent.locator(`a[href="/games/${gameId}"]`).click();
    await expectSharedResult([opponent], final, "White wins");
    const credentials = await page.request.get(API_ORIGIN + "/credentials");
    expect(credentials.status()).toBe(200);
    const listed = JSON.stringify(await credentials.json());
    expect(listed.includes(credentialId)).toBe(true);
    expect(listed.includes(key)).toBe(false);
    await privacy();
  });
}

for (const { deletedSeat, opponentKind } of [
  { deletedSeat: "owner", opponentKind: "account" },
  { deletedSeat: "opponent", opponentKind: "account" },
  { deletedSeat: "owner", opponentKind: "guest" },
] as const) {
  test(`deleting the ${deletedSeat} account with an ${opponentKind} opponent fences its live tab and preserves anonymized replay`, async ({
    page,
    newContext,
  }) => {
    const { invitation, gameId } = await createRoom(page, "Black");
    const opponent = await (await newContext()).newPage();
    if (opponentKind === "account") await createAccount(opponent.request);
    await joinRoom(opponent, invitation, gameId, opponentKind);
    await playRoomLine(opponent, page, gameId, ["e2e4", "e7e5"]);
    const deleted = deletedSeat === "owner" ? page : opponent;
    const retained = deleted === page ? opponent : page;
    const accountTab = await deleted.context().newPage();
    await accountTab.goto("/account");
    await confirm(accountTab, "Delete account", "Permanently delete account");
    await expect(
      accountTab.getByRole("heading", { name: "Account deleted", exact: true }),
    ).toBeFocused();
    await expect(deleted.getByRole("grid")).toHaveCount(0);
    await expect(
      retained.getByRole("heading", { name: "Game stopped", exact: true }),
    ).toBeVisible();
    await expect(
      retained.locator(`[data-seat="${deletedSeat === "owner" ? "black" : "white"}"]`),
    ).toContainText("Deleted player");
    const final = await readSnapshot(retained, gameId);
    expect(final).toMatchObject({
      state: "aborted",
      result: "*",
      moves: [{ uci: "e2e4" }, { uci: "e7e5" }],
    });
    await expectSharedResult([retained], final, "Game stopped");
    expect((await retained.request.get(API_ORIGIN + "/games/unfinished")).ok()).toBe(true);
    expect(await (await retained.request.get(API_ORIGIN + "/games/unfinished")).json()).toEqual({
      game: null,
    });
    if (opponentKind === "account") {
      await retained.goto("/history");
      await expect(
        retained
          .getByRole("list", { name: "Finished games" })
          .getByText("Deleted player", { exact: true }),
      ).toBeVisible();
    }
    await accountTab.close();
  });
}
