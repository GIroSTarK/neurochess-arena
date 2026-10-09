import { games, guestSessions } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import type { TestApi } from "./helpers.js";
import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(() => harness.dispose());

it("periodically purges newly expired guest-only history and disposes its timer on close", async () => {
  const { api, owner, opponent, snapshot, service } = await harness.room({ guest: true });
  if (opponent.principal.kind !== "guest") throw new Error("Expected guest");
  await service.clearHistory(owner.principal, { confirm: true });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const worker = await harness.createAuthenticatedApi();
    await worker.app.ready();
    expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(1);
    await api.database.db
      .update(guestSessions)
      .set({ lastSeenAt: new Date(0), expiresAt: new Date(1) })
      .where(eq(guestSessions.id, opponent.principal.guestSessionId));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect.poll(() => api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(0);
    await harness.close(worker);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

async function waitBlocked(api: TestApi, pid: number) {
  await expect
    .poll(
      async () =>
        (
          await api.database.db.execute<{ count: number }>(sql`
    select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
  `)
        ).rows[0]?.count,
    )
    .toBeGreaterThan(0);
}

it("denies expired guests immediately and sweeps terminal guest-only rooms on restart without aborting unfinished ones", async () => {
  const terminal = await harness.room({ guest: true });
  const unfinished = await harness.room({ guest: true, state: "active" });
  await terminal.service.clearHistory(terminal.owner.principal, { confirm: true });
  for (const fixture of [terminal, unfinished]) {
    if (fixture.opponent.principal.kind !== "guest") throw new Error("Expected guest");
    await fixture.api.database.db
      .update(guestSessions)
      .set({ lastSeenAt: new Date(0), expiresAt: new Date(1) })
      .where(eq(guestSessions.id, fixture.opponent.principal.guestSessionId));
    await expect(
      fixture.service.details(fixture.opponent.principal, fixture.snapshot.gameId),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
  const restarted = await harness.createAuthenticatedApi();
  await restarted.app.ready();
  expect(await restarted.database.db.$count(games, eq(games.id, terminal.snapshot.gameId))).toBe(0);
  expect(
    (await unfinished.service.details(unfinished.owner.principal, unfinished.snapshot.gameId))
      .snapshot.state,
  ).toBe("active");
});

it("retains a guest's aborted replay after owner deletion and cleans immediately when already expired", async () => {
  const fixture = await harness.room({ state: "active", guest: true });
  const { api, owner, opponent, snapshot, service } = fixture;
  expect(
    (await harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }))
      .statusCode,
  ).toBe(200);
  expect((await service.details(opponent.principal, snapshot.gameId)).snapshot.state).toBe(
    "aborted",
  );
  const expired = await harness.room({ state: "completed", guest: true });
  if (expired.opponent.principal.kind !== "guest") throw new Error("Expected guest");
  await expired.api.database.db
    .update(guestSessions)
    .set({ lastSeenAt: new Date(0), expiresAt: new Date(1) })
    .where(eq(guestSessions.id, expired.opponent.principal.guestSessionId));
  await expired.service.clearHistory(expired.owner.principal, { confirm: true });
  expect(await api.database.db.$count(games, eq(games.id, expired.snapshot.gameId))).toBe(0);
});

it("rechecks renewal eligibility after a row wait so an expired guest cannot revive after cleanup", async () => {
  const { api, owner, opponent, snapshot, service } = await harness.room({ guest: true });
  if (opponent.principal.kind !== "guest") throw new Error("Expected guest");
  const guestId = opponent.principal.guestSessionId;
  await service.clearHistory(owner.principal, { confirm: true });
  await api.database.db
    .update(guestSessions)
    .set({ lastSeenAt: new Date(0), expiresAt: new Date(Date.now() + 500) })
    .where(eq(guestSessions.id, guestId));
  let renewal: ReturnType<typeof api.repository.renewGuest> | undefined;
  let cleanup: Promise<void> | undefined;
  await api.database.db.transaction(async (tx) => {
    const [guest] = await tx
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, guestId))
      .for("update");
    const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
      .pid;
    renewal = api.repository.renewGuest(guest!.tokenHash, 3600);
    await waitBlocked(api, pid);
    await expect
      .poll(
        async () =>
          (
            await api.database.db.execute<{ expired: boolean }>(
              sql`select expires_at <= clock_timestamp() as expired from guest_sessions where id = ${guestId}`,
            )
          ).rows[0]?.expired,
      )
      .toBe(true);
    cleanup = service.cleanupSharedRooms();
  });
  expect(await renewal).toBeUndefined();
  await cleanup;
  expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(0);
});

it("a valid renewal committed before the cleanup guest lock preserves retained replay", async () => {
  const { api, owner, opponent, snapshot, service } = await harness.room({ guest: true });
  if (opponent.principal.kind !== "guest") throw new Error("Expected guest");
  const guestId = opponent.principal.guestSessionId;
  await service.clearHistory(owner.principal, { confirm: true });
  await api.database.db
    .update(guestSessions)
    .set({ lastSeenAt: new Date(0), expiresAt: new Date(Date.now() + 400) })
    .where(eq(guestSessions.id, guestId));
  let cleanup: Promise<void> | undefined;
  await api.database.db.transaction(async (tx) => {
    await tx
      .update(guestSessions)
      .set({ expiresAt: new Date(Date.now() + 3600_000) })
      .where(eq(guestSessions.id, guestId));
    const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
      .pid;
    await expect
      .poll(
        async () =>
          (
            await api.database.db.execute<{ expired: boolean }>(
              sql`select expires_at <= clock_timestamp() as expired from guest_sessions where id = ${guestId}`,
            )
          ).rows[0]?.expired,
      )
      .toBe(true);
    cleanup = service.cleanupSharedRooms();
    await waitBlocked(api, pid);
  });
  await cleanup;
  expect((await service.pgn(opponent.principal, snapshot.gameId)).pgn).toBe(snapshot.pgn);
});
