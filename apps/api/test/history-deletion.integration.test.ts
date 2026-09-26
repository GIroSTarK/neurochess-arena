import { randomUUID } from "node:crypto";

import type { GameSnapshot } from "@neurochess/contracts";
import {
  aiControllers,
  aiTurnReservations,
  aiTurns,
  authSchema,
  createCredentialRepository,
  gameCommands,
  gameParticipants,
  games,
  modelInvocations,
  moves,
  profiles,
  providerCredentials,
} from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_COOKIE_NAME } from "../src/auth/service.js";
import { createCredentialCipher } from "../src/credentials/encryption.js";
import { createCredentialService } from "../src/credentials/service.js";
import type { Principal } from "../src/identity/principal.js";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import {
  access,
  aiMatch,
  control,
  humanMatch,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

const harness = new AccountGameHarness();
const confirmed = { confirm: true };
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

async function terminal(api: TestApi, principal: Principal, completed = false) {
  const game = service(api, {
    openai: createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] }),
  });
  const created = await game.createAi(principal, completed ? humanMatch : aiMatch);
  const played = await game.aiTurn(principal, turnCommand(created.snapshot), access());
  return game.lifecycle(
    principal,
    completed
      ? { ...control(played, "abort"), action: "resign", losingColor: "black" }
      : control(played, "abort"),
  );
}

async function remaining(api: TestApi, snapshot: GameSnapshot, turnIds: string[]) {
  const db = api.database.db;
  return Promise.all([
    db.$count(games, eq(games.id, snapshot.gameId)),
    db.$count(gameParticipants, eq(gameParticipants.gameId, snapshot.gameId)),
    db.$count(moves, eq(moves.gameId, snapshot.gameId)),
    db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
    db.$count(aiTurns, eq(aiTurns.gameId, snapshot.gameId)),
    db.$count(modelInvocations, inArray(modelInvocations.turnId, turnIds)),
    db.$count(aiTurnReservations, eq(aiTurnReservations.gameId, snapshot.gameId)),
    db.$count(aiControllers, eq(aiControllers.gameId, snapshot.gameId)),
  ]);
}

describe("terminal account game deletion", () => {
  it("never interprets a missing or malformed individual ID as clear history", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const target = await terminal(api, owner.principal);
    for (const id of [undefined, null, "", "all", [], {}]) {
      await expect(
        service(api).deleteGame(owner.principal, id as string, confirmed),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect((await get(api, owner.cookie, `/games/${target.gameId}/replay`)).statusCode).toBe(200);
  });
  it.each([false, true])(
    "atomically cascades every dependent record (completed=%s), hides old URLs and defines repeats",
    async (completed) => {
      const api = await harness.createApi();
      const owner = await harness.account(api);
      const snapshot = await terminal(api, owner.principal, completed);
      const turns = await api.repository.read((reader) => reader.getAiTurns(snapshot.gameId));
      const ids = turns.map((turn) => turn.id);
      // Residual operational records must cascade too, even though Stop normally clears them.
      await api.database.db
        .insert(aiControllers)
        .values({ gameId: snapshot.gameId, expiresAt: new Date(0) });
      await api.database.db.insert(aiTurnReservations).values({
        gameId: snapshot.gameId,
        commandId: randomUUID(),
        reservationId: randomUUID(),
        expectedVersion: snapshot.version,
      });
      expect(await remaining(api, snapshot, ids)).toEqual([1, 2, 1, 2, 1, 1, 1, 1]);
      const response = await post(api, owner.cookie, `/games/${snapshot.gameId}/delete`, confirmed);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(await remaining(api, snapshot, ids)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
        expect(
          (await get(api, owner.cookie, `/games/${snapshot.gameId}${suffix}`)).statusCode,
        ).toBe(404);
      }
      expect(
        (await post(api, owner.cookie, `/games/${snapshot.gameId}/delete`, confirmed)).json(),
      ).toMatchObject({ code: "NOT_FOUND" });
    },
  );

  it("rejects malformed scope, foreign and guest games, missing confirmation, invalid sessions and cross-origin commands", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    const target = await terminal(api, owner.principal);
    const guestGame = await terminal(api, guest.principal);
    const sandbox = await service(api).createSandbox(guest.principal);
    await service(api).lifecycle(guest.principal, control(sandbox, "abort"));
    for (const url of [`/games/${target.gameId}/delete`, "/games/history/clear"]) {
      for (const body of [
        {},
        { confirm: false },
        { confirm: true, ownerUserId: other.userId },
        { confirm: true, gameIds: [] },
      ]) {
        expect((await post(api, owner.cookie, url, body)).statusCode).toBe(400);
      }
      expect((await post(api, owner.cookie, url + "?state=active", confirmed)).statusCode).toBe(
        400,
      );
      expect(
        (await post(api, owner.cookie, url, confirmed, { origin: "https://foreign.test" }))
          .statusCode,
      ).toBe(403);
      for (const cookie of ["", guest.cookie, `${AUTH_COOKIE_NAME}=invalid; ${guest.cookie}`]) {
        expect((await post(api, cookie, url, confirmed)).statusCode).toBe(401);
      }
    }
    for (const id of [randomUUID(), guestGame.gameId, sandbox.gameId]) {
      expect(
        (await post(api, `${owner.cookie}; ${guest.cookie}`, `/games/${id}/delete`, confirmed))
          .statusCode,
      ).toBe(404);
    }
    expect(
      (await post(api, other.cookie, `/games/${target.gameId}/delete`, confirmed)).statusCode,
    ).toBe(404);
    for (const id of ["undefined", "all", "not-a-uuid"]) {
      expect((await post(api, owner.cookie, `/games/${id}/delete`, confirmed)).statusCode).toBe(
        400,
      );
    }
    await api.database.db
      .update(authSchema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSchema.session.id, owner.principal.sessionId));
    expect(
      (await post(api, owner.cookie, `/games/${target.gameId}/delete`, confirmed)).statusCode,
    ).toBe(401);
    expect(await api.repository.read((r) => r.getGame(target.gameId))).toBeDefined();
    expect(await api.repository.read((r) => r.getGame(guestGame.gameId))).toBeDefined();
    expect(await api.repository.read((r) => r.getGame(sandbox.gameId))).toBeDefined();
  });

  it.each(["active", "paused"] as const)(
    "clears only owned terminal history and preserves %s games, credentials and profile",
    async (state) => {
      const api = await harness.createApi({
        credentials: (db) =>
          createCredentialService(
            createCredentialRepository(db),
            createCredentialCipher({
              activeKeyId: "test",
              keys: { test: Buffer.alloc(32, 17).toString("base64") },
            }),
          ),
      });
      const owner = await harness.account(api);
      const other = await harness.account(api);
      const guest = await harness.guest(api);
      const deleted = [
        await terminal(api, owner.principal),
        await terminal(api, owner.principal, true),
      ];
      const untouched = [
        await terminal(api, other.principal),
        await terminal(api, guest.principal),
      ];
      const game = service(api);
      let unfinished = (await game.createAi(owner.principal, aiMatch)).snapshot;
      if (state === "paused") {
        unfinished = await game.lifecycle(owner.principal, control(unfinished, "pause"));
      }
      expect(
        (
          await post(api, owner.cookie, "/api/credentials", {
            save: true,
            provider: "openai",
            label: "Keep",
            apiKey: "test-only-saved-key",
          })
        ).statusCode,
      ).toBe(201);
      const profileBefore = await api.database.db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, owner.userId));
      const credentialsBefore = await api.database.db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.userId, owner.userId));
      const rejected = await post(
        api,
        owner.cookie,
        `/games/${unfinished.gameId}/delete`,
        confirmed,
      );
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "INVALID_GAME_STATE" });
      expect((await post(api, owner.cookie, "/games/history/clear", confirmed)).statusCode).toBe(
        200,
      );
      expect((await post(api, owner.cookie, "/games/history/clear", confirmed)).json()).toEqual({
        success: true,
      });
      for (const snapshot of deleted) {
        expect((await get(api, owner.cookie, `/games/${snapshot.gameId}/details`)).statusCode).toBe(
          404,
        );
      }
      for (const snapshot of untouched) {
        expect(await api.repository.read((r) => r.getGame(snapshot.gameId))).toBeDefined();
      }
      expect((await get(api, owner.cookie, `/games/${unfinished.gameId}`)).json()).toEqual(
        unfinished,
      );
      expect(
        await api.database.db.select().from(profiles).where(eq(profiles.userId, owner.userId)),
      ).toEqual(profileBefore);
      expect(
        await api.database.db
          .select()
          .from(providerCredentials)
          .where(eq(providerCredentials.userId, owner.userId)),
      ).toEqual(credentialsBefore);
    },
  );

  it.each(["delete", "clear"])(
    "rolls back %s and its actual SQL cascades on transaction failure",
    async (operation) => {
      const api = await harness.createApi();
      const owner = await harness.account(api);
      const snapshot = await terminal(api, owner.principal);
      const ids = (await api.repository.read((r) => r.getAiTurns(snapshot.gameId))).map(
        (t) => t.id,
      );
      const before = await remaining(api, snapshot, ids);
      const write = api.repository.write.bind(api.repository);
      vi.spyOn(api.repository, "write").mockImplementationOnce((work) =>
        write(async (tx) => {
          await work(tx);
          expect(await tx.getGame(snapshot.gameId)).toBeUndefined();
          expect(await tx.getMoves(snapshot.gameId)).toEqual([]);
          expect(await tx.getModelInvocations(snapshot.gameId)).toEqual([]);
          throw new Error("Injected rollback after deletion");
        }),
      );
      const url =
        operation === "delete" ? `/games/${snapshot.gameId}/delete` : "/games/history/clear";
      expect((await post(api, owner.cookie, url, confirmed)).statusCode).toBe(500);
      expect(await remaining(api, snapshot, ids)).toEqual(before);
      expect((await get(api, owner.cookie, `/games/${snapshot.gameId}/replay`)).statusCode).toBe(
        200,
      );
    },
  );
});
