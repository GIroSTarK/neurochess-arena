import { randomUUID } from "node:crypto";

import {
  type AiGameConfiguration,
  GAME_IDENTITY_HEADER,
  gameDetailsSchema,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { authSchema, gameParticipants, games, guestSessions } from "@neurochess/database";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_COOKIE_NAME } from "../src/auth/service.js";
import { createGameService } from "../src/games/service.js";
import { createLoggerOptions } from "../src/logger.js";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import {
  aiMatch,
  control,
  humanMatch,
  output,
  service,
  turnCommand,
  whiteAi,
} from "./ai-turn-helpers.js";
import { command, createSandbox } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { turnCatalog } from "./providers/turn-catalog.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

describe("account-owned public games", () => {
  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "checks account session expiry using UTC under database TimeZone %s",
    async (timeZone) => {
      const api = await harness.createApi();
      const owner = await harness.account(api);
      const transaction = api.database.db.transaction.bind(api.database.db);
      const configuredTransactions = vi
        .spyOn(api.database.db, "transaction")
        .mockImplementation((action, config) =>
          transaction(async (tx) => {
            await tx.execute(sql`select set_config('TimeZone', ${timeZone}, true)`);
            return action(tx);
          }, config),
        );
      try {
        for (const [offsetMs, active] of [
          [60_000, true],
          [-60_000, false],
        ] as const) {
          await api.database.db
            .update(authSchema.session)
            .set({ expiresAt: new Date(Date.now() + offsetMs) })
            .where(eq(authSchema.session.id, owner.principal.sessionId));
          expect(
            await api.repository.read((reader) =>
              reader.hasAccountSession(owner.userId, owner.principal.sessionId),
            ),
          ).toBe(active);
          expect(
            await api.repository.write((tx) =>
              tx.lockAccountSession(owner.userId, owner.principal.sessionId),
            ),
          ).toBe(active);
        }
      } finally {
        configuredTransactions.mockRestore();
      }
    },
  );

  it("serializes creation across two real sessions and API instances, keeping public and guest Sandbox slots independent", async () => {
    const first = await harness.createApi();
    const second = await harness.createApi();
    const account = await harness.account(first);
    const otherSession = await harness.anotherSession(second, account);
    const guest = await harness.guest(first);
    const sandbox = await createSandbox(first, guest);
    const replies = await Promise.all([
      post(first, `${account.cookie}; ${guest.cookie}`, "/games", aiMatch),
      post(second, otherSession.cookie, "/games", humanMatch),
    ]);
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([201, 409]);
    const created = gameDetailsSchema.parse(
      replies.find((reply) => reply.statusCode === 201)!.json(),
    );
    expect(replies.find((reply) => reply.statusCode === 409)!.json()).toMatchObject({
      currentSnapshot: created.snapshot,
    });
    expect(await first.database.db.$count(games, eq(games.ownerUserId, account.userId))).toBe(1);
    for (const [api, cookie] of [
      [first, account.cookie],
      [second, otherSession.cookie],
    ] as const) {
      expect((await get(api, cookie, "/games/unfinished")).json()).toEqual({ game: created });
    }
    const stored = await first.repository.read((reader) => reader.getGame(created.snapshot.gameId));
    expect(stored).toMatchObject({
      ownerGuestSessionId: null,
      ownerUserId: account.userId,
      isSandbox: false,
    });
    const separate = await post(first, guest.cookie, "/games", aiMatch);
    expect(separate.statusCode).toBe(201);
    expect(
      (await get(first, `${account.cookie}; ${guest.cookie}`, "/sandbox/games/unfinished")).json(),
    ).toEqual({ snapshot: sandbox });
    expect(await first.database.db.$count(games, eq(games.ownerGuestSessionId, guest.id))).toBe(2);
    await expect(service(first).createSandbox(account.principal)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await post(first, account.cookie, "/sandbox/games", {})).statusCode).toBe(401);
  });

  it("enforces relational ownership, account uniqueness and human/AI assignment constraints in PostgreSQL", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const guest = await harness.guest(api);
    const gamesService = service(api);
    const { snapshot } = await gamesService.createAi(owner.principal, humanMatch);
    const stored = (await api.repository.read((reader) => reader.getGame(snapshot.gameId)))!;
    const seats = await api.repository.read((reader) => reader.getParticipants(snapshot.gameId));
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          color: "white",
          seatType: "ai",
          userId: null,
          guestSessionId: null,
        }),
        expect.objectContaining({
          color: "black",
          seatType: "human",
          userId: owner.userId,
          guestSessionId: null,
        }),
      ]),
    );
    for (const patch of [
      { ownerGuestSessionId: guest.id },
      { ownerUserId: null },
      { ownerUserId: "missing-account" },
      { isSandbox: true, mode: null },
    ]) {
      await expect(
        api.database.db.update(games).set(patch).where(eq(games.id, stored.id)),
      ).rejects.toThrow();
    }
    for (const state of ["active", "paused"] as const) {
      await expect(
        api.database.db.insert(games).values({ ...stored, id: randomUUID(), state }),
      ).rejects.toThrow();
    }
    const ai = seats.find((seat) => seat.seatType === "ai")!;
    const human = seats.find((seat) => seat.seatType === "human")!;
    await expect(
      api.database.db
        .update(gameParticipants)
        .set({ userId: owner.userId })
        .where(eq(gameParticipants.id, ai.id)),
    ).rejects.toThrow();
    await expect(
      api.database.db
        .update(gameParticipants)
        .set({ guestSessionId: guest.id })
        .where(eq(gameParticipants.id, human.id)),
    ).rejects.toThrow();
    await expect(
      api.database.db
        .update(gameParticipants)
        .set({ userId: "missing-account" })
        .where(eq(gameParticipants.id, human.id)),
    ).rejects.toThrow();
    await gamesService.lifecycle(owner.principal, control(snapshot, "abort"));
    expect((await gamesService.createAi(owner.principal, aiMatch)).snapshot.state).toBe("active");
    await expect(
      api.database.db.delete(authSchema.user).where(eq(authSchema.user.id, owner.userId)),
    ).rejects.toThrow();
  });

  it("keeps every private read and command isolated from another account and guests, even on stale commands", async () => {
    const adapter = createScriptedAdapter({ provider: "openai", moves: [] });
    const api = await harness.createApi({ aiAdapters: { openai: adapter } });
    const owner = await harness.account(api);
    const stranger = await harness.account(api);
    const guest = await harness.guest(api);
    const gamesService = service(api);
    const { snapshot } = await gamesService.createAi(owner.principal, humanMatch);
    const terminal = await gamesService.lifecycle(owner.principal, control(snapshot, "abort"));
    for (const cookie of [stranger.cookie, guest.cookie, `${stranger.cookie}; ${guest.cookie}`]) {
      for (const suffix of ["", "/details", "/invocations", "/replay", "/pgn"]) {
        const reply = await get(api, cookie, `/games/${snapshot.gameId}${suffix}`);
        expect(reply.statusCode, suffix).toBe(404);
        expect(reply.body).not.toContain(terminal.fen);
      }
      for (const [path, payload] of [
        ["moves", command(snapshot, "e2e4")],
        ["lifecycle", control(snapshot, "abort")],
        [
          "controller",
          { gameId: snapshot.gameId, controllerId: snapshot.gameId, action: "heartbeat" },
        ],
        ["ai-turn", { ...turnCommand(snapshot), apiKey: "fixture-only-key" }],
      ] as const) {
        const reply = await post(api, cookie, `/games/${snapshot.gameId}/${path}`, payload);
        expect(reply.statusCode, path).toBe(404);
        expect(reply.json()).not.toHaveProperty("currentSnapshot");
      }
      expect((await get(api, cookie, "/games/unfinished")).json()).toEqual({ game: null });
    }
    expect(adapter.moveCalls).toBe(0);
    expect(adapter.discoveryCalls).toBe(0);
    for (const suffix of ["", "/details", "/invocations", "/replay", "/pgn"]) {
      expect((await get(api, owner.cookie, `/games/${snapshot.gameId}${suffix}`)).statusCode).toBe(
        200,
      );
    }
  });

  it("uses account precedence, rejects invalid or missing account context, and keeps shared Sandbox routes explicitly guest-only", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const guest = await harness.guest(api);
    const sandbox = await createSandbox(api, guest);
    const gamesService = service(api);
    const guestGame = await gamesService.createAi(guest.principal, aiMatch);
    const accountGame = await gamesService.createAi(owner.principal, humanMatch);
    const both = `${owner.cookie}; ${guest.cookie}`;
    expect((await get(api, both, "/games/unfinished")).json()).toEqual({ game: accountGame });
    expect(
      (
        await get(api, both, `/games/${guestGame.snapshot.gameId}`, {
          [GAME_IDENTITY_HEADER]: "guest",
        })
      ).statusCode,
    ).toBe(404);
    const moved = await post(api, both, `/games/${sandbox.gameId}/moves`, command(sandbox, "e2e4"));
    expect(moved.statusCode).toBe(200);
    expect((await get(api, both, `/games/${sandbox.gameId}/details`)).statusCode).toBe(200);
    const paused = await post(
      api,
      both,
      `/games/${sandbox.gameId}/lifecycle`,
      control(gameSnapshotSchema.parse(moved.json()), "pause"),
    );
    expect(paused.statusCode).toBe(200);
    expect((await get(api, guest.cookie, `/games/${guestGame.snapshot.gameId}`)).statusCode).toBe(
      200,
    );
    const count = await api.database.db.$count(guestSessions);
    await api.database.db
      .update(authSchema.session)
      .set({ expiresAt: sql`(clock_timestamp() at time zone 'UTC') - interval '1 second'` })
      .where(eq(authSchema.session.id, owner.principal.sessionId));
    for (const [cookie, headers] of [
      [both, {}],
      [`${AUTH_COOKIE_NAME}=forged; ${guest.cookie}`, {}],
      [guest.cookie, { [GAME_IDENTITY_HEADER]: "account" }],
      ["", { [GAME_IDENTITY_HEADER]: "account" }],
    ] as const) {
      expect((await get(api, cookie, "/games/unfinished", headers)).statusCode).toBe(401);
      const created = await post(api, cookie, "/games", aiMatch, headers);
      expect(created.statusCode).toBe(401);
      expect(created.headers["set-cookie"]).toBeUndefined();
      expect(
        (
          await post(
            api,
            cookie,
            "/providers/models",
            { provider: "openai", apiKey: "fixture" },
            headers,
          )
        ).statusCode,
      ).toBe(401);
    }
    expect((await get(api, both, `/games/${sandbox.gameId}`)).statusCode).toBe(200);
    expect(
      (
        await get(api, guest.cookie, "/games/unfinished", {
          [GAME_IDENTITY_HEADER]: "forged-user-id",
        })
      ).statusCode,
    ).toBe(400);
    expect(await api.database.db.$count(guestSessions)).toBe(count);
  });

  it.each(["white", "black"] as const)(
    "allows only the assigned %s human seat across sessions and preserves private receipts/replay",
    async (color) => {
      const logs: string[] = [];
      const catalog = { ok: true as const, models: turnCatalog("openai") };
      const adapter = createScriptedAdapter({
        provider: "openai",
        models: [catalog, catalog],
        moves: [output("e2e4", "Account commentary")],
      });
      const api = await harness.createApi({
        aiAdapters: { openai: adapter },
        logger: {
          ...createLoggerOptions("info"),
          stream: { write: (chunk: string) => logs.push(chunk) },
        },
      });
      const owner = await harness.account(api);
      const otherSession = await harness.anotherSession(api, owner);
      const config: AiGameConfiguration = {
        mode: "ai_vs_human",
        seats:
          color === "white"
            ? { white: { type: "human" }, black: whiteAi }
            : { white: whiteAi, black: { type: "human" } },
      };
      const created = await post(api, owner.cookie, "/games", config);
      expect(created.statusCode).toBe(201);
      let snapshot = gameDetailsSchema.parse(created.json()).snapshot;
      const claim = await post(api, otherSession.cookie, `/games/${snapshot.gameId}/controller`, {
        gameId: snapshot.gameId,
        expectedVersion: 0,
        controllerId: snapshot.gameId,
        action: "acquire",
      });
      expect(claim.statusCode).toBe(200);
      const aiColor = color === "white" ? "black" : "white";
      expect(
        (
          await post(api, owner.cookie, `/games/${snapshot.gameId}/lifecycle`, {
            gameId: snapshot.gameId,
            expectedVersion: snapshot.version,
            commandId: randomUUID(),
            action: "resign",
            losingColor: aiColor,
          })
        ).statusCode,
      ).toBe(403);
      const discovery = await post(api, owner.cookie, "/providers/models", {
        provider: "openai",
        apiKey: "account-key-canary",
      });
      expect(discovery.statusCode).toBe(200);
      if (color === "black") {
        expect(
          (
            await post(
              api,
              owner.cookie,
              `/games/${snapshot.gameId}/moves`,
              command(snapshot, "e2e4"),
            )
          ).statusCode,
        ).toBe(403);
        const turn = await post(api, owner.cookie, `/games/${snapshot.gameId}/ai-turn`, {
          ...turnCommand(snapshot),
          apiKey: "account-key-canary",
        });
        expect(turn.statusCode).toBe(200);
        snapshot = gameSnapshotSchema.parse(turn.json());
      }
      const move = command(snapshot, color === "white" ? "f2f3" : "e7e5");
      const accepted = await post(
        api,
        otherSession.cookie,
        `/games/${snapshot.gameId}/moves`,
        move,
      );
      expect(accepted.statusCode).toBe(200);
      snapshot = gameSnapshotSchema.parse(accepted.json());
      expect(
        (
          await post(
            api,
            owner.cookie,
            `/games/${snapshot.gameId}/moves`,
            command(snapshot, "g2g4"),
          )
        ).statusCode,
      ).toBe(403);
      const resigned = await post(api, owner.cookie, `/games/${snapshot.gameId}/lifecycle`, {
        gameId: snapshot.gameId,
        expectedVersion: snapshot.version,
        commandId: randomUUID(),
        action: "resign",
        losingColor: color,
      });
      expect(resigned.statusCode).toBe(200);
      const terminal = gameSnapshotSchema.parse(resigned.json());
      expect(terminal).toMatchObject({
        state: "completed",
        terminationReason: "human_resignation",
        result: color === "white" ? "0-1" : "1-0",
      });
      const duplicate = await post(
        api,
        otherSession.cookie,
        `/games/${snapshot.gameId}/moves`,
        move,
      );
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ currentSnapshot: terminal });
      expect(
        (await get(api, otherSession.cookie, `/games/${snapshot.gameId}/replay`)).json(),
      ).toMatchObject({ snapshot: terminal });
      expect(
        (await get(api, otherSession.cookie, `/games/${snapshot.gameId}/pgn`)).json(),
      ).toMatchObject({ pgn: terminal.pgn });
      expect(
        (await get(api, otherSession.cookie, `/games/${snapshot.gameId}/invocations`)).statusCode,
      ).toBe(200);
      expect((await post(api, owner.cookie, "/games", aiMatch)).statusCode).toBe(201);
      expect(
        (await get(api, otherSession.cookie, `/games/${snapshot.gameId}/pgn`)).statusCode,
      ).toBe(200);
      for (const secret of [owner.token, owner.email, owner.cookie, "account-key-canary"]) {
        expect(logs.join("")).not.toContain(secret);
      }
    },
  );

  it("rejects owner control of an unassigned legacy human seat", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const { snapshot } = await service(api).createAi(owner.principal, {
      mode: "ai_vs_human",
      seats: { white: { type: "human" }, black: whiteAi },
    });
    await api.database.db.update(games).set({ mode: null }).where(eq(games.id, snapshot.gameId));
    await api.database.db
      .update(gameParticipants)
      .set({ userId: other.userId })
      .where(
        and(eq(gameParticipants.gameId, snapshot.gameId), eq(gameParticipants.seatType, "human")),
      );
    const gamesService = createGameService(api.repository, {
      nodeEnv: "test",
      sandboxEnabled: true,
    });
    await expect(
      gamesService.move(owner.principal, command(snapshot, "e2e4")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
