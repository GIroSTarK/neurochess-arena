import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { roomIssuedResponseSchema } from "@neurochess/contracts";
import {
  authSessions,
  authUsers,
  authVerifications,
  createDatabase,
  gameAnalysisSamples,
  games,
  guestSessions,
  providerCredentials,
  reconcileRestoredDatabase,
  rooms,
  runMigrations,
} from "@neurochess/database";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { abortSharedGame } from "../../apps/api/src/games/account-deletion.js";
import { authEnvironment } from "../../apps/api/test/account-game-helpers.js";
import { analysisSample } from "../../apps/api/test/analysis-helpers.js";
import { RoomSocketHarness } from "../../apps/api/test/room-socket-helpers.js";
import { command } from "../../scripts/recovery/runtime.ts";

import { environment } from "./environment.js";
import { closeRecoveryScenario } from "./lifecycle.js";
import { recoveryApiEnvironment, runReconciliation } from "./promotion.js";

it("reconciles known deletions without user sessions and preserves the surviving room participant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nc-recovery-reconcile-"));
  let infra: Awaited<ReturnType<typeof environment>> | undefined;
  const resources: { name: string; close(): unknown }[] = [];
  let scenarioFailed = false;
  try {
    const infrastructure = await environment(directory);
    infra = infrastructure;
    const databaseName = `nc_restore_${randomUUID().replaceAll("-", "")}`;
    await command("docker", [
      "exec",
      infra.target.name,
      "createdb",
      "-U",
      "postgres",
      "-O",
      "neurochess",
      databaseName,
    ]);
    const connect = () => createDatabase(infrastructure.target.url(databaseName));
    const harness = new RoomSocketHarness(connect);
    resources.push({ name: "room harness", close: () => harness.dispose() });
    let maintenance = connect();
    let maintenanceOpen = true;
    resources.unshift({
      name: "maintenance database",
      close: () => (maintenanceOpen ? maintenance.close() : undefined),
    });
    await runMigrations(maintenance);
    const { api, owner, room, invitation } = await harness.room();
    const peer = await harness.account(api);
    const waitingOwner = await harness.account(api);
    const operation = await harness.operation(api, waitingOwner.cookie);
    const waiting = roomIssuedResponseSchema.parse(
      (
        await harness.post(api, waitingOwner.cookie, "/rooms", {
          operationId: operation.operationId,
          ownerColor: "white",
        })
      ).json(),
    ).room.snapshot;
    const guest = await harness.guest(api);
    const joined = await harness.join(api, peer.cookie, invitation, randomUUID());
    expect(
      (
        await harness.post(api, peer.cookie, `/games/${room.snapshot.gameId}/analysis`, {
          samples: [analysisSample(joined.snapshot)],
        })
      ).statusCode,
    ).toBe(200);
    const soloOwner = await harness.account(api);
    const solo = (await harness.createGame(api, soloOwner.cookie)).snapshot;
    const credentialId = randomUUID();
    expect(
      (
        await harness.post(api, peer.cookie, "/credentials", {
          credentialId,
          provider: "openai",
          label: "Fixture",
          apiKey: "synthetic-revoked-key",
          save: true,
        })
      ).statusCode,
    ).toBe(201);
    await maintenance.db.insert(authVerifications).values({
      id: randomUUID(),
      identifier: "synthetic-recovery-record",
      value: peer.principal.userId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await maintenance.db
      .update(authSessions)
      .set({ createdAt: new Date(0), expiresAt: new Date(1) });
    expect(
      (await harness.post(api, owner.cookie, "/api/auth/delete-account", { confirm: true }))
        .statusCode,
    ).toBe(401);
    await harness.close(api);
    const manifest = {
      confirm: "reconcile-isolated-restore-v1",
      accounts: [owner.principal.userId, soloOwner.principal.userId],
      history: [],
      credentials: [{ userId: peer.principal.userId, credentialId }],
      guests: [guest.id],
      invitations: [waiting.gameId],
      invalidateSessions: true,
    };
    const otherConnection = connect();
    let otherOpen = true;
    resources.push({
      name: "secondary database",
      close: () => (otherOpen ? otherConnection.close() : undefined),
    });
    await otherConnection.check();
    await expect(reconcileRestoredDatabase(maintenance, manifest, abortSharedGame)).rejects.toThrow(
      "RESTORE_RECONCILIATION_REFUSED",
    );
    await otherConnection.close();
    otherOpen = false;
    await maintenance.close();
    maintenanceOpen = false;
    const apiEnv = await recoveryApiEnvironment(directory, infra, databaseName, {
      auth: authEnvironment.BETTER_AUTH_SECRET,
      keyId: "integration-fixture",
      key: Buffer.alloc(32, 7).toString("base64"),
    });
    const manifestFile = join(directory, "reconcile.json");
    await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    try {
      expect(await runReconciliation(infra, apiEnv, manifestFile)).toContain('"status":"success"');
    } finally {
      maintenance = connect();
      maintenanceOpen = true;
    }
    expect(await maintenance.db.$count(authUsers, eq(authUsers.id, owner.principal.userId))).toBe(
      0,
    );
    expect(await maintenance.db.$count(games, eq(games.id, solo.gameId))).toBe(0);
    expect(await maintenance.db.$count(providerCredentials)).toBe(0);
    expect(await maintenance.db.$count(authSessions)).toBe(0);
    expect(await maintenance.db.$count(authVerifications)).toBe(0);
    expect(
      (await maintenance.db.select().from(rooms).where(eq(rooms.gameId, waiting.gameId)))[0]
        ?.invitationDigest,
    ).toBeNull();
    expect(
      (
        await maintenance.db.select().from(guestSessions).where(eq(guestSessions.id, guest.id))
      )[0]!.expiresAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
    const [retained] = await maintenance.db
      .select()
      .from(games)
      .where(eq(games.id, room.snapshot.gameId));
    expect(retained).toMatchObject({ state: "aborted", ownerUserId: null });
    expect(
      await maintenance.db.$count(
        gameAnalysisSamples,
        eq(gameAnalysisSamples.userId, peer.principal.userId),
      ),
    ).toBe(1);
    await reconcileRestoredDatabase(maintenance, manifest, abortSharedGame);
    expect(
      (await maintenance.db.select().from(games).where(eq(games.id, waiting.gameId)))[0]?.version,
    ).toBe(waiting.version + 1);
    await reconcileRestoredDatabase(
      maintenance,
      {
        ...manifest,
        accounts: [],
        history: [{ userId: peer.principal.userId, gameId: room.snapshot.gameId }],
        credentials: [],
      },
      abortSharedGame,
    );
    expect(await maintenance.db.$count(games, eq(games.id, room.snapshot.gameId))).toBe(0);
    expect(await maintenance.db.$count(gameAnalysisSamples)).toBe(0);
    const ordinary = createDatabase(infra.source.url("neurochess"));
    resources.push({ name: "source database", close: () => ordinary.close() });
    await expect(reconcileRestoredDatabase(ordinary, manifest, abortSharedGame)).rejects.toThrow(
      "RESTORE_RECONCILIATION_REFUSED",
    );
  } catch (error) {
    scenarioFailed = true;
    throw error;
  } finally {
    await closeRecoveryScenario(
      {
        resources,
        infrastructure: () => infra?.close(),
        directory,
        prefix: "nc-recovery-reconcile-",
      },
      scenarioFailed,
    );
  }
});
