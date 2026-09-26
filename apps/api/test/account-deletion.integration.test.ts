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
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_COOKIE_NAME, createAuth } from "../src/auth/service.js";
import { createCredentialCipher } from "../src/credentials/encryption.js";
import { createCredentialService } from "../src/credentials/service.js";

import { AccountGameHarness, get } from "./account-game-helpers.js";
import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import { AUTH_ENVIRONMENT, TestMailbox } from "./auth-helpers.js";
import { command, type TestApi, WEB_ORIGIN } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

const harness = new AccountGameHarness();
const confirmed = (expectedUserId: string) => ({ confirm: true, expectedUserId });
const path = "/api/auth/delete-account";
let requestNumber = 0;
function post(
  api: TestApi,
  cookie: string,
  url: string,
  payload: object,
  headers: Record<string, string> = {},
) {
  requestNumber++;
  return api.app.inject({
    method: "POST",
    url,
    payload,
    remoteAddress: `198.19.${Math.floor(requestNumber / 256)}.${requestNumber % 256}`,
    headers: { origin: WEB_ORIGIN, cookie, ...headers },
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

describe("confirmed account deletion", () => {
  it("cannot delete a replacement browser account using a confirmation for another identity", async () => {
    const api = await harness.createApi();
    const displayed = await harness.account(api);
    const replacement = await harness.account(api);
    const response = await post(api, replacement.cookie, path, {
      confirm: true,
      expectedUserId: displayed.userId,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "AUTH_ACCOUNT_CHANGED" });
    for (const account of [displayed, replacement]) {
      expect((await get(api, account.cookie, "/api/profile")).statusCode).toBe(200);
    }
  });
  it("atomically removes account data, unfinished games, all devices and recovery records without affecting guests or other accounts", async () => {
    const mailbox = new TestMailbox();
    const api = await harness.createApi({
      auth: (db) => createAuth(db, AUTH_ENVIRONMENT, { emailSender: mailbox }),
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
    const device = await harness.anotherSession(api, owner);
    const guest = await harness.guest(api);
    const game = service(api, {
      openai: createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] }),
    });
    const created = await game.createAi(owner.principal, aiMatch);
    const played = await game.aiTurn(owner.principal, turnCommand(created.snapshot), access());
    await game.lifecycle(owner.principal, control(played, "abort"));
    const unfinished = (await game.createAi(owner.principal, aiMatch)).snapshot;
    await game.lifecycle(owner.principal, control(unfinished, "pause"));
    const otherGame = await game.createAi(other.principal, aiMatch);
    const guestGame = await game.createAi(guest.principal, aiMatch);
    const sandbox = await game.createSandbox(guest.principal);
    const gameIds = [created.snapshot.gameId, unfinished.gameId];
    const turns = await api.database.db
      .select({ id: aiTurns.id })
      .from(aiTurns)
      .where(inArray(aiTurns.gameId, gameIds));
    const saved = await post(api, owner.cookie, "/api/credentials", {
      save: true,
      provider: "openai",
      label: "Delete with account",
      apiKey: "test-only-account-deletion-key",
    });
    expect(saved.statusCode).toBe(201);
    expect(
      (await post(api, "", "/api/auth/request-password-reset", { email: owner.email })).statusCode,
    ).toBe(200);
    const resetToken = mailbox.token(owner.email, "reset");
    expect(
      await api.database.db.$count(
        authSchema.verification,
        eq(authSchema.verification.value, owner.userId),
      ),
    ).toBe(1);
    const response = await post(
      api,
      `${owner.cookie}; ${guest.cookie}`,
      path,
      confirmed(owner.userId),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      response.cookies.some((cookie) => cookie.name === AUTH_COOKIE_NAME && cookie.maxAge === 0),
    ).toBe(true);
    for (const table of [authSchema.session, authSchema.account, profiles, providerCredentials]) {
      expect(await api.database.db.$count(table, eq(table.userId, owner.userId))).toBe(0);
    }
    expect(
      await api.database.db.$count(authSchema.user, eq(authSchema.user.id, owner.userId)),
    ).toBe(0);
    expect(
      await api.database.db.$count(
        authSchema.verification,
        eq(authSchema.verification.value, owner.userId),
      ),
    ).toBe(0);
    expect(await api.database.db.$count(games, inArray(games.id, gameIds))).toBe(0);
    for (const table of [
      gameParticipants,
      moves,
      gameCommands,
      aiTurns,
      aiTurnReservations,
      aiControllers,
    ]) {
      expect(await api.database.db.$count(table, inArray(table.gameId, gameIds))).toBe(0);
    }
    expect(
      await api.database.db.$count(
        modelInvocations,
        inArray(
          modelInvocations.turnId,
          turns.map((turn) => turn.id),
        ),
      ),
    ).toBe(0);
    for (const cookie of [owner.cookie, device.cookie]) {
      expect((await get(api, cookie, "/api/auth/get-session")).json()).toEqual({ session: null });
      expect((await get(api, cookie, "/api/profile")).statusCode).toBe(401);
      expect((await post(api, cookie, path, confirmed(owner.userId))).statusCode).toBe(401);
      for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
        expect(
          (await get(api, cookie, `/games/${created.snapshot.gameId}${suffix}`)).statusCode,
        ).toBe(401);
      }
    }
    expect(
      (
        await post(api, "", "/api/auth/reset-password", {
          token: resetToken,
          newPassword: "replacement-password-123",
        })
      ).statusCode,
    ).toBe(400);
    expect((await get(api, other.cookie, `/games/${otherGame.snapshot.gameId}`)).statusCode).toBe(
      200,
    );
    expect((await get(api, guest.cookie, `/games/${guestGame.snapshot.gameId}`)).statusCode).toBe(
      200,
    );
    expect((await get(api, guest.cookie, `/games/${sandbox.gameId}`)).statusCode).toBe(200);
  });

  it("requires exact confirmation, same origin and a fresh authenticated session, and keeps built-in deletion closed", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    for (const payload of [{}, { confirm: false }, { confirm: true, userId: other.userId }]) {
      expect((await post(api, owner.cookie, path, payload)).statusCode).toBe(400);
    }
    expect(
      (await post(api, owner.cookie, path + "?all=true", confirmed(owner.userId))).statusCode,
    ).toBe(400);
    expect(
      (
        await post(api, owner.cookie, path, confirmed(owner.userId), {
          origin: "https://foreign.test",
        })
      ).statusCode,
    ).toBe(403);
    for (const cookie of ["", guest.cookie, `${AUTH_COOKIE_NAME}=forged; ${guest.cookie}`]) {
      expect((await post(api, cookie, path, confirmed(owner.userId))).statusCode).toBe(401);
    }
    for (const route of ["/delete-user", "/delete-user/callback"]) {
      expect((await post(api, owner.cookie, "/api/auth" + route, {})).statusCode).toBe(404);
    }
    await api.database.db
      .update(authSchema.session)
      .set({ createdAt: new Date(Date.now() - 3_601_000) })
      .where(eq(authSchema.session.id, owner.principal.sessionId));
    expect((await post(api, owner.cookie, path, confirmed(owner.userId))).json()).toMatchObject({
      code: "AUTH_REAUTHENTICATION_REQUIRED",
    });
    expect(
      await api.database.db.$count(authSchema.user, eq(authSchema.user.id, owner.userId)),
    ).toBe(1);
    const fresh = await harness.anotherSession(api, owner);
    expect((await post(api, fresh.cookie, path, confirmed(owner.userId))).statusCode).toBe(200);
    expect((await get(api, other.cookie, "/api/profile")).statusCode).toBe(200);
  });

  it.each(["success", "invalid"])(
    "fences a late %s provider result, new commands, controller renewal and automatic retries across devices",
    async (outcome) => {
      const api = await harness.createApi();
      const otherInstance = await harness.createApi();
      const owner = await harness.account(api);
      const second = await harness.anotherSession(otherInstance, owner);
      const gate = gatedAdapter();
      const game = service(api, { openai: gate.adapter });
      const { snapshot } = await game.createAi(owner.principal, aiMatch);
      const pending = game
        .aiTurn(owner.principal, turnCommand(snapshot), access())
        .catch((error: unknown) => error);
      await gate.entered;
      try {
        expect(
          (await post(otherInstance, second.cookie, path, confirmed(owner.userId))).statusCode,
        ).toBe(200);
        gate.resolve(
          outcome === "success"
            ? output("e2e4", "late private commentary")
            : {
                ok: false,
                error: { code: "model_invalid", reason: "illegal_move" },
                durationMs: 1,
                usage: null,
                providerRequestId: null,
              },
        );
        expect(await pending).toMatchObject({ code: "UNAUTHORIZED" });
        expect(gate.adapter.moveCalls).toBe(1);
        for (const operation of [
          () => game.createAi(owner.principal, aiMatch),
          () => game.lifecycle(owner.principal, control(snapshot, "pause")),
          () => game.move(owner.principal, command(snapshot, "e2e4")),
          () =>
            game.controller(owner.principal, {
              gameId: snapshot.gameId,
              controllerId: snapshot.gameId,
              action: "heartbeat",
            }),
          () => game.aiTurn(owner.principal, turnCommand(snapshot), access()),
        ]) {
          await expect(operation()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        }
        await game.expireControllers();
        expect(
          await api.repository.read((reader) => reader.getGame(snapshot.gameId)),
        ).toBeUndefined();
        expect(
          await api.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
        ).toEqual([]);
      } finally {
        gate.resolve(output("e2e4"));
        await pending;
      }
    },
  );

  it("rolls back application and auth cascades on failure and does not clear the cookie", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const { snapshot } = await service(api).createAi(owner.principal, aiMatch);
    const transaction = api.database.db.transaction.bind(api.database.db);
    vi.spyOn(api.database.db, "transaction").mockImplementationOnce((work) =>
      transaction(async (tx) => {
        await work(tx);
        expect(
          await tx.select().from(authSchema.user).where(eq(authSchema.user.id, owner.userId)),
        ).toEqual([]);
        expect(await tx.select().from(games).where(eq(games.id, snapshot.gameId))).toEqual([]);
        throw new Error("private-rollback-canary");
      }),
    );
    const response = await post(api, owner.cookie, path, confirmed(owner.userId));
    expect(response.statusCode).toBe(500);
    expect(response.cookies).toEqual([]);
    expect(response.body).not.toContain("private-rollback-canary");
    expect((await get(api, owner.cookie, "/api/profile")).statusCode).toBe(200);
    expect((await get(api, owner.cookie, `/games/${snapshot.gameId}`)).statusCode).toBe(200);
  });

  it("rechecks session freshness after waiting for the user lock", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    let pending: ReturnType<typeof post> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx
        .select()
        .from(authSchema.user)
        .where(eq(authSchema.user.id, owner.userId))
        .for("update");
      pending = post(api, owner.cookie, path, confirmed(owner.userId));
      // Fastify inject is lazy; start the request before releasing the lock.
      void pending.then(() => undefined);
      await vi.waitFor(async () => {
        const waiting = await api.database.db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select "id" from "user"%'`,
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
      await tx
        .update(authSchema.session)
        .set({ createdAt: sql`(clock_timestamp() at time zone 'UTC') - interval '2 hours'` })
        .where(eq(authSchema.session.id, owner.principal.sessionId));
    });
    expect((await pending)!.json()).toMatchObject({ code: "AUTH_REAUTHENTICATION_REQUIRED" });
    expect((await get(api, owner.cookie, "/api/profile")).statusCode).toBe(200);
  });

  it.each(["game", "session"] as const)(
    "rolls back every cascade if the session expires while deletion waits for a %s lock",
    async (lock) => {
      const api = await harness.createApi();
      const owner = await harness.account(api);
      const device = await harness.anotherSession(api, owner);
      const { snapshot } = await service(api).createAi(owner.principal, aiMatch);
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const holding = api.database.db.transaction(async (tx) => {
        if (lock === "game") {
          await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
        } else {
          await tx
            .select()
            .from(authSchema.session)
            .where(eq(authSchema.session.id, device.principal.sessionId))
            .for("update");
        }
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      await api.database.db
        .update(authSchema.session)
        .set({ expiresAt: new Date(Date.now() + 1_000) })
        .where(eq(authSchema.session.id, owner.principal.sessionId));
      const deleting = post(api, owner.cookie, path, confirmed(owner.userId)).then(
        (response) => response,
      );
      try {
        await vi.waitFor(async () => {
          const waiting = await api.database.db.execute(
            sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like ${lock === "game" ? 'delete from "games"%' : 'delete from "user"%'}`,
          );
          expect(waiting.rows.length).toBeGreaterThan(0);
        });
        await vi.waitFor(
          async () =>
            expect(
              await api.repository.read((r) =>
                r.hasAccountSession(owner.userId, owner.principal.sessionId),
              ),
            ).toBe(false),
          { timeout: 3_000 },
        );
      } finally {
        release.resolve();
        await holding;
      }
      expect((await deleting).statusCode).toBe(401);
      expect((await get(api, device.cookie, "/api/profile")).statusCode).toBe(200);
      expect((await get(api, device.cookie, `/games/${snapshot.gameId}`)).statusCode).toBe(200);
    },
  );

  it("serializes deletion with commands already authenticated on another device", async () => {
    const api = await harness.createApi();
    const secondApi = await harness.createApi();
    const owner = await harness.account(api);
    const device = await harness.anotherSession(secondApi, owner);
    const { snapshot } = await service(api).createAi(owner.principal, aiMatch);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = api.database.db.transaction.bind(api.database.db);
    vi.spyOn(api.database.db, "transaction").mockImplementationOnce((work) =>
      transaction(async (tx) => {
        const result = await work(tx);
        entered.resolve();
        await release.promise;
        return result;
      }),
    );
    const deleting = post(api, owner.cookie, path, confirmed(owner.userId)).then(
      (response) => response,
    );
    let queued: Promise<unknown> | undefined;
    try {
      await entered.promise;
      queued = service(secondApi)
        .lifecycle(device.principal, control(snapshot, "pause"))
        .catch((error: unknown) => error);
      await vi.waitFor(async () => {
        const waiting = await secondApi.database.db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select "id" from "user"%'`,
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
    } finally {
      release.resolve();
    }
    expect((await deleting).statusCode).toBe(200);
    expect(await queued).toMatchObject({ code: "UNAUTHORIZED" });
    expect(await api.repository.read((r) => r.getGame(snapshot.gameId))).toBeUndefined();
  });
});
