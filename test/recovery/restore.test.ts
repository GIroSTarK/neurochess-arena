import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createGame } from "@neurochess/chess";
import {
  authUsers,
  createDatabase,
  games,
  guestSessions,
  modelInvocations,
  providerCredentials,
  runMigrations,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";

import { createAccountAuth } from "../../apps/api/src/auth/service.js";
import { createCredentialCipher } from "../../apps/api/src/credentials/crypto.js";
import { createProviderCredentialAccess } from "../../apps/api/src/credentials/provider-access.js";
import { createGameService } from "../../apps/api/src/games/service.js";
import { requireActivePrincipal } from "../../apps/api/src/identity/validity.js";
import { authEnvironment } from "../../apps/api/test/account-game-helpers.js";
import { control, output } from "../../apps/api/test/ai-turn-helpers.js";
import { createScriptedAdapter } from "../../apps/api/test/providers/scripted-adapter.js";
import { withTurnCatalog } from "../../apps/api/test/providers/turn-catalog.js";
import { RoomSocketHarness } from "../../apps/api/test/room-socket-helpers.js";
import { deriveSignals } from "../../scripts/monitoring/policy.ts";
import { backup } from "../../scripts/recovery/backup.ts";
import { restore } from "../../scripts/recovery/restore.ts";
import { type Command, command } from "../../scripts/recovery/runtime.ts";

import { environment } from "./environment.js";
import { fixtures } from "./fixtures.js";
import { promote, recoveryApiEnvironment, runReconciliation } from "./promotion.js";

it("recovers a private populated database and separate secrets, then reconciles post-backup deletions before reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nc-recovery-drill-"));
  const infra = await environment(directory).catch(async (error: unknown) => {
    expect(dirname(directory)).toBe(tmpdir());
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const sourceHarness = new RoomSocketHarness(() => createDatabase(infra.source.url("neurochess")));
  let restoredUrl = "";
  const targetHarness = new RoomSocketHarness(() => createDatabase(restoredUrl));
  let targetDisposed = false;
  vi.stubGlobal("fetch", () => {
    throw new Error("OUTBOUND_NETWORK_DISABLED");
  });
  try {
    const secretDirectory = join(directory, "separate-secret-store");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(secretDirectory, { mode: 0o700 });
    const identityFile = join(secretDirectory, "identity");
    const recipientFile = join(directory, "recipient");
    await command("age-keygen", ["-o", identityFile]);
    await command("age-keygen", ["-y", identityFile], { outputFile: recipientFile });
    const key = randomBytes(32).toString("base64");
    const secrets = { auth: authEnvironment.BETTER_AUTH_SECRET, keyId: "recovery-fixture-v1", key };
    const secretPlain = join(secretDirectory, "secrets.json");
    const secretArchive = join(secretDirectory, "secrets.age");
    await writeFile(secretPlain, JSON.stringify(secrets), { mode: 0o600 });
    await command("age", ["-R", recipientFile, secretPlain], { outputFile: secretArchive });
    await rm(secretPlain);
    const cipher = createCredentialCipher({ keyId: secrets.keyId, key });
    const source = await sourceHarness.createAuthenticatedApi({
      credentialCipher: cipher,
      aiAdapters: {
        openai: withTurnCatalog(
          createScriptedAdapter({ provider: "openai", moves: [output("f2f3"), output("g2g4")] }),
        ),
        anthropic: withTurnCatalog(
          createScriptedAdapter({ provider: "anthropic", moves: [output("e7e5"), output("d8h4")] }),
        ),
      },
    });
    await runMigrations(source.database);
    await runMigrations(source.database);
    const fixture = await fixtures(sourceHarness, source);
    const read = (api: typeof source, cookie: string, path: string) =>
      api.app.inject({ url: path, headers: { cookie } });
    const paths = ["", "/replay", "/pgn", "/invocations", "/analysis"];
    const originals = await Promise.all(
      paths.map(async (path) =>
        (
          await read(source, fixture.owner.cookie, `/games/${fixture.solo.gameId}${path}`)
        ).json<unknown>(),
      ),
    );
    const journal = (
      await source.database.db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)
    ).rows;
    const backupDirectory = join(directory, "backup");
    const archiveFile = join(directory, "off-host.age");
    const cloud: Command = async (program, args, options) => {
      if (program !== "oci") return command(program, args, options);
      if (args[1] === "bucket") {
        return JSON.stringify({
          data: { "public-access-type": "NoPublicAccess", versioning: "Disabled" },
        });
      }
      if (args[1] === "object-lifecycle-policy") {
        return JSON.stringify({
          data: {
            items: [
              {
                action: "DELETE",
                "is-enabled": true,
                target: "objects",
                "time-amount": 7,
                "time-unit": "DAYS",
                "object-name-filter": { "inclusion-prefixes": ["database/"] },
              },
            ],
          },
        });
      }
      if (args[2] === "list") return '{"prefixes":[]}';
      if (args[2] === "put") await copyFile(args[args.indexOf("--file") + 1]!, archiveFile);
      else if (args[2] === "get") await copyFile(archiveFile, options!.outputFile!);
      else throw new Error("UNEXPECTED_CLOUD_OPERATION");
      return "{}";
    };
    const backupStarted = performance.now();
    await backup(
      {
        container: infra.source.name,
        database: "neurochess",
        role: "neurochess",
        directory: backupDirectory,
        recipientFile,
        namespace: "synthetic",
        bucket: "synthetic",
      },
      cloud,
    );
    const backupMs = Math.ceil(performance.now() - backupStarted);
    expect(await readdir(backupDirectory)).toEqual(["status.json"]);
    const status = JSON.parse(
      await readFile(join(backupDirectory, "status.json"), "utf8"),
    ) as unknown;
    expect(
      deriveSignals(null, null, { now: Date.now(), backup: status, backupMaxAgeSeconds: 86400 })
        .backupFailure,
    ).toBe(0);
    expect(
      deriveSignals(null, null, {
        now: Date.now() + 86_401_000,
        backup: status,
        backupMaxAgeSeconds: 86400,
      }).backupFailure,
    ).toBe(1);
    expect((await readFile(archiveFile)).includes(Buffer.from(fixture.providerKey))).toBe(false);
    // These requests deliberately postdate the recovery point and must be reapplied to the restored copy.
    expect(
      (
        await sourceHarness.post(source, fixture.owner.cookie, "/credentials/revoke", {
          credentialId: fixture.credentialId,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await sourceHarness.post(
          source,
          fixture.owner.cookie,
          `/games/${fixture.solo.gameId}/delete`,
          { gameId: fixture.solo.gameId, confirm: true },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await sourceHarness.post(source, fixture.recovering.cookie, "/api/auth/delete-account", {
          confirm: true,
        })
      ).statusCode,
    ).toBe(200);
    await sourceHarness.close(source);

    const recoveryStarted = performance.now();
    const restoreConfig = {
      container: infra.target.name,
      role: "neurochess",
      directory: join(directory, "restore"),
      archiveFile,
      identityFile,
    };
    const wrongIdentity = join(secretDirectory, "wrong-identity");
    await command("age-keygen", ["-o", wrongIdentity]);
    await expect(restore({ ...restoreConfig, identityFile: wrongIdentity })).rejects.toThrow(
      /^RESTORE_FAILED$/,
    );
    await expect(
      restore({ ...restoreConfig, identityFile: join(secretDirectory, "missing") }),
    ).rejects.toThrow(/^RESTORE_FAILED$/);
    const damaged = join(directory, "damaged.age");
    const bytes = await readFile(archiveFile);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(damaged, bytes);
    await expect(restore({ ...restoreConfig, archiveFile: damaged })).rejects.toThrow(
      /^RESTORE_FAILED$/,
    );
    const result = await restore(restoreConfig);
    restoredUrl = infra.target.url(result.database);
    await command("age", ["-d", "-i", identityFile, secretArchive], { outputFile: secretPlain });
    const recoveredSecrets = JSON.parse(await readFile(secretPlain, "utf8")) as typeof secrets;
    await rm(secretPlain);
    const recoveredCipher = createCredentialCipher({
      keyId: recoveredSecrets.keyId,
      key: recoveredSecrets.key,
    });
    const restored = await targetHarness.createApi({
      credentialCipher: recoveredCipher,
      auth: (database, events) =>
        createAccountAuth(
          database,
          { ...authEnvironment, BETTER_AUTH_SECRET: recoveredSecrets.auth },
          undefined,
          events,
        ),
    });
    await runMigrations(restored.database);
    await runMigrations(restored.database);
    expect(
      (
        await restored.database.db.execute(
          sql`select * from drizzle.__drizzle_migrations order by id`,
        )
      ).rows,
    ).toEqual(journal);
    for (const [index, path] of paths.entries()) {
      const response = await read(
        restored,
        fixture.owner.cookie,
        `/games/${fixture.solo.gameId}${path}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(originals[index]);
      expect(
        (await read(restored, fixture.outsider.cookie, `/games/${fixture.solo.gameId}${path}`))
          .statusCode,
      ).toBe(404);
    }
    const legal = createGame();
    legal.start();
    for (const move of fixture.solo.moves) legal.playMove(move.uci);
    expect(legal.snapshot().fen).toBe(fixture.solo.fen);
    expect(legal.snapshot().result).toEqual(fixture.solo.result);
    expect(
      (await read(restored, fixture.guest.cookie, `/games/${fixture.guestSolo.gameId}`)).statusCode,
    ).toBe(200);
    expect(
      (await read(restored, fixture.owner.cookie, `/games/${fixture.shared.gameId}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await read(restored, fixture.peer.cookie, `/games/${fixture.shared.gameId}/analysis`)
      ).json(),
    ).toMatchObject({ samples: [{ score: { kind: "cp", value: -42 } }] });
    const wrongAuth = createAccountAuth(restored.database, {
      ...authEnvironment,
      BETTER_AUTH_SECRET: "wrong-recovery-auth-secret-at-least-32-characters",
    });
    expect(await wrongAuth.resolve(new Headers({ cookie: fixture.owner.cookie }))).toBeNull();
    for (const testCipher of [
      recoveredCipher,
      undefined,
      createCredentialCipher({ keyId: secrets.keyId, key: randomBytes(32).toString("base64") }),
    ]) {
      const access = createProviderCredentialAccess(restored.repository, testCipher);
      const used = await access(
        fixture.owner.principal,
        "openai",
        { credentialId: fixture.credentialId, signal: new AbortController().signal },
        (tx) => requireActivePrincipal(tx, fixture.owner.principal),
        async (input) => input.apiKey === fixture.providerKey,
      );
      expect(used).toBe(testCipher === recoveredCipher ? true : null);
    }
    const service = createGameService(restored.repository, {
      nodeEnv: "test",
      sandboxEnabled: false,
    });
    const beforeRecovery = await service.snapshot(
      fixture.recovering.principal,
      fixture.unfinished.gameId,
    );
    const paused = await service.lifecycle(
      fixture.recovering.principal,
      control(beforeRecovery, "pause"),
    );
    expect(paused.state).toBe("paused");
    expect(paused.moves).toEqual([]);
    await service.controller(fixture.recovering.principal, {
      gameId: paused.gameId,
      controllerId: paused.gameId,
      expectedVersion: paused.version,
      action: "acquire",
    });
    const resumed = await service.lifecycle(
      fixture.recovering.principal,
      control(paused, "resume"),
    );
    expect(resumed.state).toBe("active");
    expect(resumed.moves).toEqual([]);
    // The restored socket owner starts afresh and sends canonical snapshots to both seats.
    for (const [cookie, identity] of [
      [fixture.roomOwner.cookie, fixture.roomOwner.principal.userId],
      [fixture.guest.cookie, "guest"],
    ]) {
      const socket = await targetHarness.connect(restored, cookie!);
      socket.subscribe(fixture.active.gameId, identity!);
      expect((await socket.next("snapshot")).room.snapshot).toEqual(fixture.active);
      socket.socket.terminate();
    }
    expect(
      (
        await targetHarness.post(restored, fixture.owner.cookie, "/credentials/revoke", {
          credentialId: fixture.credentialId,
        })
      ).statusCode,
    ).toBe(200);
    expect(await restored.database.db.$count(providerCredentials)).toBe(0);
    expect(
      (
        await targetHarness.post(
          restored,
          fixture.owner.cookie,
          `/games/${fixture.solo.gameId}/delete`,
          { gameId: fixture.solo.gameId, confirm: true },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await targetHarness.post(restored, fixture.recovering.cookie, "/api/auth/delete-account", {
          confirm: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await restored.database.db.$count(
        authUsers,
        eq(authUsers.id, fixture.recovering.principal.userId),
      ),
    ).toBe(0);
    expect(await restored.database.db.$count(games, eq(games.id, fixture.unfinished.gameId))).toBe(
      0,
    );
    for (const path of paths) {
      expect(
        (await read(restored, fixture.owner.cookie, `/games/${fixture.solo.gameId}${path}`))
          .statusCode,
      ).toBe(404);
    }
    expect(await restored.database.db.$count(modelInvocations)).toBe(0);
    for (const table of ["moves", "game_commands", "ai_turns", "game_analysis_samples"]) {
      const remaining = await restored.database.db.execute(
        sql`select count(*)::int as count from ${sql.identifier(table)} where game_id = ${fixture.solo.gameId}::uuid`,
      );
      expect(remaining.rows[0]?.count).toBe(0);
    }
    await restored.database.db
      .update(guestSessions)
      .set({ lastSeenAt: new Date(0), expiresAt: new Date(1) })
      .where(eq(guestSessions.id, fixture.guest.id));
    expect(
      (await read(restored, fixture.guest.cookie, `/games/${fixture.active.gameId}`)).statusCode,
    ).toBe(401);
    await service.cleanupSharedRooms();
    expect((await service.snapshot(fixture.roomOwner.principal, fixture.active.gameId)).state).toBe(
      "active",
    );
    const aborted = await service.lifecycle(
      fixture.roomOwner.principal,
      control(fixture.active, "abort"),
    );
    expect(aborted.state).toBe("aborted");
    await service.deleteGame(fixture.roomOwner.principal, {
      gameId: fixture.active.gameId,
      confirm: true,
    });
    await service.cleanupSharedRooms();
    expect(await restored.database.db.$count(games, eq(games.id, fixture.active.gameId))).toBe(0);
    await targetHarness.dispose();
    targetDisposed = true;
    const apiEnv = await recoveryApiEnvironment(directory, infra, result.database, {
      ...recoveredSecrets,
      auth: randomBytes(32).toString("hex"),
    });
    const manifestFile = join(directory, "reconcile.json");
    await writeFile(
      manifestFile,
      JSON.stringify({
        confirm: "reconcile-isolated-restore-v1",
        accounts: [],
        history: [],
        credentials: [],
        invalidateSessions: true,
      }),
      { mode: 0o600 },
    );
    expect(await runReconciliation(infra, apiEnv, manifestFile)).toContain('"status":"success"');
    const promoted = await promote(directory, infra, apiEnv);
    try {
      expect(
        (await promoted.read(`/games/${fixture.shared.gameId}`, fixture.peer.cookie)).status,
      ).toBe(401);
      const signedIn = await promoted.read("/api/auth/sign-in/email", "", {
        email: fixture.peer.email,
        password: fixture.peer.password,
      });
      expect(signedIn.status).toBe(200);
      const readBack = await promoted.read(`/games/${fixture.shared.gameId}`, signedIn.cookie);
      expect(readBack.status).toBe(200);
      expect(readBack.body).toMatchObject({ fen: fixture.shared.fen, state: "completed" });
      await backup(
        {
          container: promoted.container,
          database: result.database,
          role: "neurochess",
          directory: join(directory, "promoted-backup"),
          recipientFile,
          namespace: "synthetic",
          bucket: "synthetic",
        },
        cloud,
      );
    } finally {
      await promoted.close();
    }
    const recoveryMs = Math.ceil(performance.now() - recoveryStarted);
    expect(recoveryMs).toBeLessThan(7_200_000);
    const evidence = {
      event: "recovery_drill",
      backupBytes: (await stat(archiveFile)).size,
      backupMs,
      restoreMs: result.durationMs,
      recoveryMs,
      targetMs: 7_200_000,
    };
    if (process.env.RECOVERY_EVIDENCE_FILE) {
      await writeFile(process.env.RECOVERY_EVIDENCE_FILE, JSON.stringify(evidence));
    }
  } finally {
    vi.unstubAllGlobals();
    try {
      if (!targetDisposed) await targetHarness.dispose();
      await sourceHarness.dispose();
    } finally {
      await infra.close();
      expect(dirname(directory)).toBe(tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  }
});
