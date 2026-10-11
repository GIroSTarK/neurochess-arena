import { authSessions, authUsers, gameAnalysisSamples, games } from "@neurochess/database";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { createAnalysisService } from "../src/analysis/service.js";

import { analysisSample } from "./analysis-helpers.js";
import type { TestApi } from "./helpers.js";
import { terminalGame } from "./history-deletion-helpers.js";
import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(() => harness.dispose());

async function blocked(api: TestApi, pid: number, count = 1) {
  await expect
    .poll(
      async () =>
        (
          await api.database.db.execute<{ count: number }>(sql`
    with recursive blocked(pid) as (
      select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
      union select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid))
    ) select count(*)::int as count from blocked
  `)
        ).rows[0]?.count,
    )
    .toBe(count);
}

it("serializes cross-tab writes and keeps the first committed score on a depth tie", async () => {
  const { api, owner, snapshot } = await harness.room();
  const other = await harness.createAuthenticatedApi();
  const first = createAnalysisService(api.repository);
  const second = createAnalysisService(other.repository);
  const sample = analysisSample(snapshot);
  let winning: ReturnType<typeof first.write> | undefined;
  let losing: ReturnType<typeof first.write> | undefined;
  await api.database.db.transaction(async (tx) => {
    await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
    const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
      .pid;
    winning = first.write(owner.principal, snapshot.gameId, { samples: [sample] });
    await blocked(api, pid);
    losing = second.write(owner.principal, snapshot.gameId, {
      samples: [{ ...sample, score: { kind: "cp", value: -500 } }],
    });
    await blocked(api, pid, 2);
  });
  expect(await losing).toEqual(await winning);
  const deeper = { ...sample, depth: 18, score: { kind: "cp", value: -32 } };
  await Promise.all([
    first.write(owner.principal, snapshot.gameId, { samples: [deeper] }),
    second.write(owner.principal, snapshot.gameId, { samples: [sample] }),
  ]);
  expect((await first.read(owner.principal, snapshot.gameId, {})).samples).toEqual([
    expect.objectContaining(deeper),
  ]);
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      eq(gameAnalysisSamples.gameId, snapshot.gameId),
    ),
  ).toBe(1);
});

it.each([
  ["solo", "single"],
  ["solo", "clear"],
  ["solo", "account"],
  ["room", "single"],
  ["room", "clear"],
  ["room", "account"],
] as const)(
  "fences a late upload after %s %s deletion across API connections",
  async (scope, action) => {
    const fixture =
      scope === "room"
        ? await harness.room()
        : await (async () => {
            const api = await harness.createAuthenticatedApi();
            const owner = await harness.account(api);
            return { api, owner, snapshot: await terminalGame(harness, api, owner) };
          })();
    const { api, owner, snapshot } = fixture;
    const other = await harness.createAuthenticatedApi();
    const analysis = createAnalysisService(other.repository);
    const sample = analysisSample(snapshot);
    await analysis.write(owner.principal, snapshot.gameId, { samples: [sample] });
    let deleting: ReturnType<typeof harness.post> | undefined;
    let writing: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      const path =
        action === "single"
          ? `/games/${snapshot.gameId}/delete`
          : action === "clear"
            ? "/games/history/clear"
            : "/api/auth/delete-account";
      deleting = harness.post(api, owner.cookie, path, {
        confirm: true,
        ...(action === "single" ? { gameId: snapshot.gameId } : {}),
      });
      await blocked(api, pid);
      writing = analysis
        .write(owner.principal, snapshot.gameId, { samples: [{ ...sample, depth: 18 }] })
        .catch((error: unknown) => error);
      await blocked(api, pid, 2);
    });
    expect((await deleting)?.statusCode).toBe(200);
    expect(await writing).toMatchObject({
      code: action === "account" ? "UNAUTHORIZED" : "NOT_FOUND",
    });
    expect(
      await api.database.db.$count(
        gameAnalysisSamples,
        eq(gameAnalysisSamples.userId, owner.principal.userId),
      ),
    ).toBe(0);
  },
);

it("deletion erases an upload that commits first without taking the peer account lock", async () => {
  const { api, owner, opponent, snapshot } = await harness.room();
  if (opponent.principal.kind !== "account") throw new Error("Expected account");
  const peerId = opponent.principal.userId;
  const other = await harness.createAuthenticatedApi();
  const analysis = createAnalysisService(other.repository);
  let writing: ReturnType<typeof analysis.write> | undefined;
  let deleting: ReturnType<typeof harness.post> | undefined;
  await api.database.db.transaction(async (peer) => {
    await peer.select().from(authUsers).where(eq(authUsers.id, peerId)).for("update");
    await api.database.db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      writing = analysis.write(owner.principal, snapshot.gameId, {
        samples: [analysisSample(snapshot)],
      });
      await blocked(api, pid);
      deleting = harness.post(api, owner.cookie, `/games/${snapshot.gameId}/delete`, {
        gameId: snapshot.gameId,
        confirm: true,
      });
      await blocked(api, pid, 2);
    });
    expect((await writing)?.samples).toHaveLength(1);
    expect((await deleting)?.statusCode).toBe(200);
  });
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      eq(gameAnalysisSamples.gameId, snapshot.gameId),
    ),
  ).toBe(0);
});

it.each(["account", "game", "gate"] as const)(
  "rechecks the exact session after a %s lock wait",
  async (lock) => {
    const { api, owner, snapshot } = await harness.room();
    const other = await harness.createAuthenticatedApi();
    const analysis = createAnalysisService(other.repository);
    let writing: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      if (lock === "account") {
        await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, owner.principal.userId))
          .for("update");
      }
      if (lock === "game") {
        await tx.select().from(games).where(eq(games.id, snapshot.gameId)).for("update");
      }
      if (lock === "gate") await tx.execute(sql`select pg_advisory_xact_lock(1848788328, 4)`);
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
      writing = analysis
        .write(owner.principal, snapshot.gameId, { samples: [analysisSample(snapshot)] })
        .catch((error: unknown) => error);
      await blocked(api, pid);
      await tx.delete(authSessions).where(eq(authSessions.id, owner.principal.sessionId));
    });
    expect(await writing).toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      await api.database.db.$count(
        gameAnalysisSamples,
        eq(gameAnalysisSamples.gameId, snapshot.gameId),
      ),
    ).toBe(0);
  },
);

it("rolls back earlier replacements when the session expires during a later sample lock wait", async () => {
  const { api, owner, snapshot } = await harness.room();
  const other = await harness.createAuthenticatedApi();
  const analysis = createAnalysisService(other.repository);
  const samples = [analysisSample(snapshot), analysisSample(snapshot, 1)];
  await analysis.write(owner.principal, snapshot.gameId, { samples });
  const before = await api.database.db
    .select()
    .from(gameAnalysisSamples)
    .where(eq(gameAnalysisSamples.gameId, snapshot.gameId));
  let writing: Promise<unknown> | undefined;
  await api.database.db.transaction(async (tx) => {
    await tx
      .select()
      .from(gameAnalysisSamples)
      .where(and(eq(gameAnalysisSamples.gameId, snapshot.gameId), eq(gameAnalysisSamples.ply, 1)))
      .for("update");
    const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
      .pid;
    writing = analysis
      .write(owner.principal, snapshot.gameId, {
        samples: samples.map((sample) => ({ ...sample, depth: 18 })),
      })
      .catch((error: unknown) => error);
    await blocked(api, pid);
    await tx
      .update(authSessions)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSessions.id, owner.principal.sessionId));
  });
  expect(await writing).toMatchObject({ code: "UNAUTHORIZED" });
  expect(
    await api.database.db
      .select()
      .from(gameAnalysisSamples)
      .where(eq(gameAnalysisSamples.gameId, snapshot.gameId)),
  ).toEqual(before);
});

it("allows an in-flight consistent read but denies new reads after deletion commits", async () => {
  const { api, owner, snapshot } = await harness.room();
  const analysis = createAnalysisService(api.repository);
  const saved = await analysis.write(owner.principal, snapshot.gameId, {
    samples: [analysisSample(snapshot)],
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reader = createAnalysisService({
    ...api.repository,
    read: (action) =>
      api.repository.read((tx) =>
        action({
          ...tx,
          getGame: async (id) => {
            const game = await tx.getGame(id);
            entered.resolve();
            await release.promise;
            return game;
          },
        }),
      ),
  });
  const reading = reader.read(owner.principal, snapshot.gameId, {});
  await entered.promise;
  try {
    expect(
      (
        await harness.post(api, owner.cookie, `/games/${snapshot.gameId}/delete`, {
          gameId: snapshot.gameId,
          confirm: true,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    release.resolve();
  }
  expect((await reading).samples).toEqual(saved.samples);
  await expect(analysis.read(owner.principal, snapshot.gameId, {})).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
