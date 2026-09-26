import { gameHistoryPageSchema, unfinishedGameDetailsSchema } from "@neurochess/contracts";
import { authSchema, type GameRepository, games } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";

const harness = new AccountGameHarness();
const confirmed = { confirm: true };
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

function holdWrite(repository: GameRepository) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = repository.write.bind(repository);
  vi.spyOn(repository, "write").mockImplementationOnce((work) =>
    write(async (tx) => {
      const result = await work(tx);
      entered.resolve();
      await release.promise;
      return result;
    }),
  );
  return { entered: entered.promise, release: () => release.resolve() };
}

async function waitingForOwner(api: TestApi) {
  await vi.waitFor(async () => {
    const waiting = await api.database.db.execute(
      sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select "id" from "user"%'`,
    );
    expect(waiting.rows.length).toBeGreaterThan(0);
  });
}

describe("history deletion concurrency", () => {
  it.each(["clear", "finish"] as const)(
    "serializes a concurrent finish at the owner lock when %s wins",
    async (first) => {
      const api = await harness.createApi();
      const second = await harness.createApi();
      const owner = await harness.account(api);
      const another = await harness.anotherSession(second, owner);
      const game = service(api);
      const archived = (await game.createAi(owner.principal, aiMatch)).snapshot;
      await game.lifecycle(owner.principal, control(archived, "abort"));
      const active = (await game.createAi(owner.principal, aiMatch)).snapshot;
      const held = holdWrite(api.repository);
      const leading =
        first === "clear"
          ? game.clearHistory(owner.principal, confirmed)
          : game.lifecycle(owner.principal, control(active, "abort"));
      let following: Promise<unknown> | undefined;
      try {
        await held.entered;
        following =
          first === "clear"
            ? service(second).lifecycle(another.principal, control(active, "abort"))
            : service(second).clearHistory(another.principal, confirmed);
        await waitingForOwner(second);
      } finally {
        held.release();
        await leading;
        await following;
      }
      const response = await get(second, another.cookie, "/games/history");
      expect(response.statusCode).toBe(200);
      expect(gameHistoryPageSchema.parse(response.json()).games.map((g) => g.gameId)).toEqual(
        first === "clear" ? [active.gameId] : [],
      );
      // Each repeated clear is a fresh boundary, including games finished since the first.
      await service(second).clearHistory(another.principal, confirmed);
      expect(
        gameHistoryPageSchema.parse((await get(second, another.cookie, "/games/history")).json())
          .games,
      ).toEqual([]);
    },
  );

  it("races clear, individual delete, creation and reads across sessions without partial history or scope expansion", async () => {
    const api = await harness.createApi();
    const second = await harness.createApi();
    const owner = await harness.account(api);
    const another = await harness.anotherSession(second, owner);
    const other = await harness.account(second);
    const game = service(api);
    const target = (await game.createAi(owner.principal, aiMatch)).snapshot;
    await game.lifecycle(owner.principal, control(target, "abort"));
    const foreign = (await service(second).createAi(other.principal, aiMatch)).snapshot;
    await service(second).lifecycle(other.principal, control(foreign, "abort"));
    const held = holdWrite(api.repository);
    const clearing = post(api, owner.cookie, "/games/history/clear", confirmed);
    let deleting: ReturnType<typeof post> | undefined;
    let creating: ReturnType<typeof post> | undefined;
    try {
      await held.entered;
      deleting = post(second, another.cookie, `/games/${target.gameId}/delete`, confirmed);
      creating = post(second, another.cookie, "/games", aiMatch);
      await waitingForOwner(second);
      const before = await get(second, another.cookie, "/games/history");
      expect(before.statusCode).toBe(200);
      expect(gameHistoryPageSchema.parse(before.json()).games[0]).toMatchObject({
        gameId: target.gameId,
        players: { white: { type: "ai" }, black: { type: "ai" } },
      });
      expect((await get(second, another.cookie, `/games/${target.gameId}/replay`)).statusCode).toBe(
        200,
      );
    } finally {
      held.release();
      expect((await clearing).statusCode).toBe(200);
    }
    expect((await deleting).statusCode).toBe(404);
    expect((await creating).statusCode).toBe(201);
    expect((await get(second, another.cookie, `/games/${target.gameId}/replay`)).statusCode).toBe(
      404,
    );
    expect(
      gameHistoryPageSchema.parse((await get(second, another.cookie, "/games/history")).json())
        .games,
    ).toEqual([]);
    expect((await get(second, other.cookie, `/games/${foreign.gameId}/replay`)).statusCode).toBe(
      200,
    );
    expect(
      unfinishedGameDetailsSchema.parse(
        (await get(second, another.cookie, "/games/unfinished")).json(),
      ).game?.snapshot.state,
    ).toBe("active");
  });

  it.each(["delete", "clear"])(
    "rechecks session expiry after %s waits for the owner lock",
    async (operation) => {
      const api = await harness.createApi();
      const second = await harness.createApi();
      const owner = await harness.account(api);
      const another = await harness.anotherSession(second, owner);
      const game = service(api);
      const target = (await game.createAi(owner.principal, aiMatch)).snapshot;
      await game.lifecycle(owner.principal, control(target, "abort"));
      const held = holdWrite(api.repository);
      const holding = api.repository.write((tx) => tx.lockAccount(owner.userId));
      let deleting: ReturnType<typeof post> | undefined;
      try {
        await held.entered;
        deleting = post(
          second,
          another.cookie,
          operation === "clear" ? "/games/history/clear" : `/games/${target.gameId}/delete`,
          confirmed,
        );
        await waitingForOwner(second);
        await api.database.db
          .update(authSchema.session)
          .set({ expiresAt: new Date(0) })
          .where(eq(authSchema.session.id, another.principal.sessionId));
      } finally {
        held.release();
        await holding;
      }
      expect((await deleting).statusCode).toBe(401);
      expect((await get(api, owner.cookie, `/games/${target.gameId}/replay`)).statusCode).toBe(200);
    },
  );

  it("rolls back a deletion when the session expires while waiting for game rows", async () => {
    const api = await harness.createApi();
    const second = await harness.createApi();
    const owner = await harness.account(api);
    const game = service(api);
    const target = (await game.createAi(owner.principal, aiMatch)).snapshot;
    await game.lifecycle(owner.principal, control(target, "abort"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = api.database.db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, target.gameId)).for("update");
      entered.resolve();
      await release.promise;
    });
    await second.database.db
      .update(authSchema.session)
      .set({ expiresAt: new Date(Date.now() + 2_000) })
      .where(eq(authSchema.session.id, owner.principal.sessionId));
    let deleting: ReturnType<typeof post> | undefined;
    try {
      await entered.promise;
      deleting = post(second, owner.cookie, `/games/${target.gameId}/delete`, confirmed);
      await vi.waitFor(async () => {
        const waiting = await api.database.db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'delete from "games"%'`,
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
      await vi.waitFor(
        async () => {
          expect(
            await second.repository.read((r) =>
              r.hasAccountSession(owner.userId, owner.principal.sessionId),
            ),
          ).toBe(false);
        },
        { timeout: 4_000 },
      );
    } finally {
      release.resolve();
      await holding;
    }
    expect((await deleting).statusCode).toBe(401);
    expect(await api.repository.read((r) => r.getGame(target.gameId))).toBeDefined();
  });

  it("does not recreate a stopped and deleted game when an already dispatched AI result arrives", async () => {
    const api = await harness.createApi();
    const owner = await harness.account(api);
    const gate = gatedAdapter();
    const game = service(api, { openai: gate.adapter });
    const active = (await game.createAi(owner.principal, aiMatch)).snapshot;
    const result = game.aiTurn(owner.principal, turnCommand(active), access());
    const outcome = result.catch((error: unknown) => error);
    try {
      await gate.entered;
      await game.lifecycle(owner.principal, control(active, "abort"));
      await game.deleteGame(owner.principal, active.gameId, confirmed);
    } finally {
      gate.resolve(output("e2e4"));
    }
    expect(await outcome).toMatchObject({ code: "NOT_FOUND" });
    expect(await api.repository.read((r) => r.getGame(active.gameId))).toBeUndefined();
    expect(await api.repository.read((r) => r.getAiTurns(active.gameId))).toEqual([]);
    expect(await api.repository.read((r) => r.getModelInvocations(active.gameId))).toEqual([]);
  });
});
