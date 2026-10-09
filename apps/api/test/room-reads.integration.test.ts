import { createHash, randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import { gameDetailsSchema } from "@neurochess/contracts";
import { authSessions, gameParticipants, games, guestSessions, rooms } from "@neurochess/database";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { authorizeHumanSeat } from "../src/games/authorization.js";
import { positionOf, transportSnapshot } from "../src/games/command-persistence.js";
import { createGameService } from "../src/games/service.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { command, FOOLS_MATE } from "./helpers.js";

const harness = new AccountGameHarness();
const gameIds: string[] = [];
afterEach(async () => {
  const db = integrationDatabase();
  try {
    if (gameIds.length) await db.db.delete(games).where(inArray(games.id, gameIds.splice(0)));
  } finally {
    await db.close();
    await harness.dispose();
  }
});

async function fixture(
  options: {
    ownerColor?: "white" | "black";
    opponent?: "account" | "guest";
    state?: "waiting" | "joined" | "completed";
  } = {},
) {
  const api = await harness.createAuthenticatedApi();
  const owner = await harness.account(api);
  const opponent =
    options.opponent === "account" ? await harness.account(api) : await harness.guest(api);
  const outsider = await harness.guest(api);
  const ownerColor = options.ownerColor ?? "white";
  const state = options.state ?? "joined";
  const gameId = randomUUID();
  gameIds.push(gameId);
  const game = createGame();
  game.start();
  if (state === "waiting") game.pause();
  for (const move of state === "completed" ? FOOLS_MATE : []) game.playMove(move);
  const snapshot = transportSnapshot(gameId, game.snapshot().moves.length, game.snapshot());
  const digest = createHash("sha256").update("test-only-invitation").update(gameId).digest("hex");
  await api.repository.write(async (tx) => {
    await tx.insertGame(
      {
        id: gameId,
        ownerUserId: owner.principal.userId,
        mode: "human_vs_human",
        ...positionOf(snapshot),
      },
      (["white", "black"] as const).map((color) => ({
        gameId,
        color,
        seatType: "human",
        ...(color === ownerColor
          ? { userId: owner.principal.userId }
          : state === "waiting"
            ? {}
            : opponent.principal.kind === "account"
              ? { userId: opponent.principal.userId }
              : { guestSessionId: opponent.principal.guestSessionId }),
      })),
    );
    await tx.insertRoom({
      gameId,
      ownerColor,
      state: state === "waiting" ? "waiting" : "joined",
      invitationDigest: state === "waiting" ? digest : null,
      joinedAt: state === "waiting" ? null : new Date(),
    });
    for (const move of snapshot.moves) {
      const commandId = randomUUID();
      await tx.appendMove({ ...move, gameId, commandId, version: move.ply });
      await tx.appendCommand({ gameId, commandId, kind: "move", version: move.ply });
    }
  });
  const service = createGameService(api.repository, { nodeEnv: "test", sandboxEnabled: false });
  return { api, owner, opponent, outsider, ownerColor, snapshot, digest, service };
}

describe("seeded private human game reads", () => {
  it("restores an anonymized terminal room for its original guest participant", async () => {
    const { api, owner, opponent, snapshot, service } = await fixture({ state: "completed" });
    await api.database.db
      .update(games)
      .set({ ownerUserId: null })
      .where(eq(games.id, snapshot.gameId));
    await api.database.db
      .update(gameParticipants)
      .set({ userId: null })
      .where(eq(gameParticipants.userId, owner.principal.userId));
    expect((await service.details(opponent.principal, snapshot.gameId)).snapshot).toEqual(snapshot);
    await expect(service.details(owner.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("removes seeded room history access while retaining the guest's replay", async () => {
    const { owner, opponent, snapshot, service } = await fixture({ state: "completed" });
    expect((await service.history(owner.principal, { limit: 20 })).games).toHaveLength(1);
    await service.deleteGame(owner.principal, { gameId: snapshot.gameId, confirm: true });
    await service.clearHistory(owner.principal, { confirm: true });
    await expect(service.details(owner.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await service.details(opponent.principal, snapshot.gameId)).snapshot).toEqual(snapshot);
  });
  it.each(["white", "black"] as const)(
    "restores account participants with owner %s and grants only their own seat",
    async (ownerColor) => {
      const { api, owner, opponent, snapshot } = await fixture({ ownerColor, opponent: "account" });
      const restarted = await harness.createAuthenticatedApi();
      for (const player of [owner, opponent]) {
        const response = await restarted.app.inject({
          url: `/games/${snapshot.gameId}/details`,
          headers: { cookie: player.cookie },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(gameDetailsSchema.parse(response.json())).toEqual({
          snapshot,
          configuration: {
            mode: "human_vs_human",
            seats: { white: { type: "human" }, black: { type: "human" } },
          },
        });
        expect(response.body).not.toContain(owner.principal.userId);
        const stored = await api.repository.read((reader) => reader.getGame(snapshot.gameId));
        const seats = await api.repository.read((reader) =>
          reader.getParticipants(snapshot.gameId),
        );
        for (const color of ["white", "black"] as const) {
          const allowed = (player === owner) === (color === ownerColor);
          const authorize = () =>
            authorizeHumanSeat(player.principal, stored!, seats, color, false);
          if (allowed) expect(authorize).not.toThrow();
          else expect(authorize).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
        }
      }
    },
  );

  it("restores a waiting Black owner privately without exposing admission or identities", async () => {
    const { api, owner, opponent, snapshot, digest } = await fixture({
      ownerColor: "black",
      state: "waiting",
    });
    const response = await api.app.inject({
      url: `/games/${snapshot.gameId}/details`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      snapshot: { state: "paused", turn: "white", moves: [], legalMoves: [] },
      configuration: { mode: "human_vs_human" },
    });
    for (const privateValue of [digest, "invitation", "ownerUserId", "guestSessionId"]) {
      expect(response.body).not.toContain(privateValue);
    }
    const denied = await api.app.inject({
      url: `/games/${snapshot.gameId}/details`,
      headers: { cookie: opponent.cookie },
    });
    expect(denied.statusCode).toBe(404);
  });

  it("authorizes participant replay/PGN and denies outsider reads and conflict snapshots", async () => {
    const { api, owner, opponent, outsider, snapshot } = await fixture({ state: "completed" });
    for (const suffix of ["", "/details", "/replay", "/pgn"]) {
      for (const player of [owner, opponent]) {
        const response = await api.app.inject({
          url: `/games/${snapshot.gameId}${suffix}`,
          headers: { cookie: player.cookie },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).toContain(
          snapshot.pgn.replaceAll("\n", "\\n").replaceAll('"', '\\"'),
        );
      }
      const response = await api.app.inject({
        url: `/games/${snapshot.gameId}${suffix}`,
        headers: { cookie: outsider.cookie },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).not.toHaveProperty("currentSnapshot");
    }
    const conflict = await harness.post(api, outsider.cookie, `/games/${snapshot.gameId}/moves`, {
      ...command(snapshot, "e2e4"),
      expectedVersion: 0,
    });
    expect(conflict.statusCode).toBe(404);
    expect(conflict.json()).not.toHaveProperty("currentSnapshot");
  });

  it("rejects expired guest and account sessions without changing room state", async () => {
    const { api, owner, opponent, snapshot, service } = await fixture();
    if (opponent.principal.kind !== "guest") throw new Error("Expected guest fixture");
    await api.database.db
      .update(guestSessions)
      .set({ lastSeenAt: new Date(0), expiresAt: new Date(1) })
      .where(eq(guestSessions.id, opponent.principal.guestSessionId));
    await api.database.db
      .delete(authSessions)
      .where(eq(authSessions.userId, owner.principal.userId));
    for (const player of [owner, opponent]) {
      await expect(service.details(player.principal, snapshot.gameId)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    expect(await api.repository.read((reader) => reader.getGame(snapshot.gameId))).toMatchObject({
      state: "active",
      version: 0,
    });
  });

  it("keeps rooms out of AI execution, invocation reads and expiry, and leaves gameplay gated for later PRs", async () => {
    const { api, owner, snapshot, service } = await fixture();
    const controller = {
      gameId: snapshot.gameId,
      controllerId: randomUUID(),
      action: "acquire",
      expectedVersion: 0,
    };
    await expect(service.controller(owner.principal, controller)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(service.invocations(owner.principal, snapshot.gameId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      service.aiTurn(
        owner.principal,
        {
          gameId: snapshot.gameId,
          controllerId: controller.controllerId,
          expectedVersion: 0,
          commandId: randomUUID(),
        },
        { apiKey: "fixture", signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const action of ["pause", "resume", "abort", "resign"] as const) {
      await expect(
        service.lifecycle(owner.principal, {
          gameId: snapshot.gameId,
          commandId: randomUUID(),
          expectedVersion: 0,
          ...(action === "resign" ? { action, losingColor: "white" as const } : { action }),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(service.move(owner.principal, command(snapshot, "e2e4"))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await api.repository.expiredAiControllers()).not.toContainEqual(
      expect.objectContaining({ gameId: snapshot.gameId }),
    );
    await service.expireControllers();
    expect((await service.details(owner.principal, snapshot.gameId)).snapshot).toEqual(snapshot);
    expect(await api.repository.write((tx) => tx.getAiController(snapshot.gameId))).toBeUndefined();
    expect(
      await api.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
    ).toEqual([]);
  });

  it("rejects inconsistent room metadata and seat assignments instead of treating rooms as legacy games", async () => {
    const { api, owner, snapshot, service } = await fixture({ state: "waiting" });
    await api.database.db
      .update(gameParticipants)
      .set({ userId: null })
      .where(
        sql`${gameParticipants.gameId} = ${snapshot.gameId} and ${gameParticipants.color} = 'white'`,
      );
    await expect(service.details(owner.principal, snapshot.gameId)).rejects.toMatchObject({
      name: "GameIntegrityError",
    });
    await api.database.db
      .update(gameParticipants)
      .set({ userId: owner.principal.userId })
      .where(
        sql`${gameParticipants.gameId} = ${snapshot.gameId} and ${gameParticipants.color} = 'white'`,
      );
    await api.database.db.delete(rooms).where(eq(rooms.gameId, snapshot.gameId));
    await expect(service.details(owner.principal, snapshot.gameId)).rejects.toMatchObject({
      name: "GameIntegrityError",
    });
  });
});
