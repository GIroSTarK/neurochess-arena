import { randomUUID } from "node:crypto";

import { gameDetailsSchema, gameSnapshotSchema } from "@neurochess/contracts";
import { authSessions, gameParticipants, games } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createLoggerOptions } from "../src/logger.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { aiMatch, control, humanMatch, turnCommand } from "./ai-turn-helpers.js";
import { command, createSandbox, WEB_ORIGIN } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { turnCatalog } from "./providers/turn-catalog.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

describe("account-owned game HTTP authority", () => {
  it("serializes two sessions on different API instances into one public unfinished slot", async () => {
    const api = await harness.createAuthenticatedApi();
    const otherApi = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const second = await account.anotherSession();
    const responses = await Promise.all([
      harness.post(api, account.cookie, "/games", aiMatch),
      harness.post(otherApi, second.cookie, "/games", humanMatch),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const created = gameDetailsSchema.parse(
      responses.find((response) => response.statusCode === 201)!.json(),
    );
    expect(responses.find((response) => response.statusCode === 409)!.json()).toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: created.snapshot,
    });
    const [stored] = await api.database.db
      .select()
      .from(games)
      .where(eq(games.id, created.snapshot.gameId));
    expect(stored).toMatchObject({
      ownerGuestSessionId: null,
      ownerUserId: account.principal.userId,
    });
    const discovered = await otherApi.app.inject({
      url: "/games/unfinished",
      headers: { cookie: second.cookie },
    });
    expect(discovered.json()).toEqual({ game: created });
    expect(discovered.headers["set-cookie"]).toBeUndefined();
  });

  it("prefers an account over a guest for public games while Sandbox keeps both-seat guest authority", async () => {
    const api = await harness.createAuthenticatedApi();
    const guest = await harness.guest(api);
    const guestGame = await harness.createGame(api, guest.cookie);
    const sandbox = await createSandbox(api, guest);
    const account = await harness.account(api);
    const combined = `${account.cookie}; ${guest.cookie}`;
    const accountGame = await harness.createGame(api, combined, humanMatch);
    const guestIntent = await api.app.inject({
      url: "/games/unfinished",
      headers: { cookie: combined, "x-neurochess-identity": "guest" },
    });
    expect(guestIntent.json()).toEqual({ game: accountGame });
    for (const suffix of ["", "/details", "/invocations", "/replay", "/pgn"]) {
      const denied = await api.app.inject({
        url: `/games/${guestGame.snapshot.gameId}${suffix}`,
        headers: { cookie: combined },
      });
      expect(denied.statusCode).toBe(404);
    }
    const sandboxMove = await harness.post(
      api,
      combined,
      `/games/${sandbox.gameId}/moves`,
      command(sandbox, "e2e4"),
    );
    expect(sandboxMove.statusCode, sandboxMove.body).toBe(200);
    const blackMove = await harness.post(
      api,
      combined,
      `/games/${sandbox.gameId}/moves`,
      command(gameSnapshotSchema.parse(sandboxMove.json()), "e7e5"),
    );
    expect(blackMove.statusCode).toBe(200);
    const seats = await api.database.db
      .select()
      .from(gameParticipants)
      .where(eq(gameParticipants.gameId, accountGame.snapshot.gameId));
    expect(seats.find((seat) => seat.color === "black")).toMatchObject({
      seatType: "human",
      guestSessionId: null,
      userId: account.principal.userId,
    });
    expect(seats.find((seat) => seat.color === "white")).toMatchObject({
      seatType: "ai",
      guestSessionId: null,
      userId: null,
    });
  });

  it("never falls back from revoked account cookies or explicit account intent to a guest", async () => {
    const api = await harness.createAuthenticatedApi();
    const guest = await harness.guest(api);
    const account = await harness.account(api);
    await api.database.db
      .delete(authSessions)
      .where(eq(authSessions.userId, account.principal.userId));
    for (const headers of [
      { cookie: `${account.cookie}; ${guest.cookie}` },
      { cookie: guest.cookie, "x-neurochess-identity": "account" },
      { cookie: "__Secure-neurochess.session_token=forged; " + guest.cookie },
    ]) {
      const response = await api.app.inject({
        method: "POST",
        url: "/games",
        payload: aiMatch,
        headers: { origin: WEB_ORIGIN, ...headers },
      });
      expect(response.statusCode, response.body).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const explicitGuest = await api.app.inject({
      method: "POST",
      url: "/games",
      payload: aiMatch,
      headers: {
        origin: WEB_ORIGIN,
        cookie: `${account.cookie}; ${guest.cookie}`,
        "x-neurochess-identity": "guest",
      },
    });
    expect(explicitGuest.statusCode).toBe(201);
    expect(explicitGuest.headers["set-cookie"]).toBeDefined();
  });

  it("keeps private reads, commands and conflict snapshots inaccessible to other accounts", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const { snapshot } = await harness.createGame(api, owner.cookie);
    for (const suffix of ["", "/details", "/invocations", "/replay", "/pgn"]) {
      const denied = await api.app.inject({
        url: `/games/${snapshot.gameId}${suffix}`,
        headers: { cookie: other.cookie },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.body).not.toContain(snapshot.fen);
    }
    for (const [suffix, payload] of [
      ["moves", command(snapshot, "e2e4")],
      ["lifecycle", control(snapshot, "abort")],
      ["ai-turn", { ...turnCommand(snapshot), apiKey: "fixture-key" }],
      [
        "controller",
        {
          gameId: snapshot.gameId,
          controllerId: randomUUID(),
          action: "acquire",
          expectedVersion: 0,
        },
      ],
    ] as const) {
      const denied = await harness.post(
        api,
        other.cookie,
        `/games/${snapshot.gameId}/${suffix}`,
        payload,
      );
      expect(denied.statusCode, denied.body).toBe(404);
      expect(denied.body).not.toContain("currentSnapshot");
    }
    expect(
      (
        await harness.post(
          api,
          owner.cookie,
          `/games/${snapshot.gameId}/moves`,
          command(snapshot, "e2e4"),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await harness.post(api, owner.cookie, `/games/${snapshot.gameId}/lifecycle`, {
          gameId: snapshot.gameId,
          expectedVersion: snapshot.version,
          commandId: randomUUID(),
          action: "resign",
          losingColor: "white",
        })
      ).statusCode,
    ).toBe(403);
  });

  it("authenticates discovery, validates identity intent and origins, and redacts account/provider secrets", async () => {
    const logs: string[] = [];
    const api = await harness.createAuthenticatedApi({
      logger: {
        ...createLoggerOptions("info"),
        stream: {
          write: (chunk: string) => {
            logs.push(chunk);
          },
        },
      },
      aiAdapters: {
        openai: createScriptedAdapter({
          provider: "openai",
          models: [{ ok: true, models: turnCatalog("openai") }],
        }),
      },
    });
    const account = await harness.account(api);
    const apiKey = "account-provider-key-redaction-canary";
    const response = await harness.post(api, account.cookie, "/providers/models", {
      provider: "openai",
      apiKey,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    expect(response.body).not.toContain(apiKey);
    expect(response.body).not.toContain(account.principal.sessionId);
    for (const headers of [
      { origin: "https://untrusted.example" },
      { origin: WEB_ORIGIN, "x-neurochess-identity": "unknown" },
    ]) {
      const rejected = await api.app.inject({
        method: "POST",
        url: "/games",
        payload: aiMatch,
        headers: { cookie: account.cookie, ...headers },
      });
      expect(rejected.statusCode).toBe(headers.origin === WEB_ORIGIN ? 400 : 403);
    }
    for (const identity of [
      { userId: account.principal.userId },
      { sessionId: account.principal.sessionId },
      { kind: "account" },
    ]) {
      expect(
        (await harness.post(api, account.cookie, "/games", { ...aiMatch, ...identity })).statusCode,
      ).toBe(400);
    }
    for (const secret of [
      apiKey,
      account.cookie,
      ...account.cookie.split("; ").map((cookie) => cookie.slice(cookie.indexOf("=") + 1)),
    ]) {
      expect(logs.join("")).not.toContain(secret);
    }
  });
});
