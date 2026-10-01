import { randomUUID } from "node:crypto";

import { credentialListResponseSchema, credentialMetadataSchema } from "@neurochess/contracts";
import {
  authSessions,
  authUsers,
  createCredentialRepository,
  providerCredentials,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createCredentialCipher } from "../src/credentials/crypto.js";
import { createCredentialService } from "../src/credentials/service.js";
import { createLoggerOptions } from "../src/logger.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { WEB_ORIGIN } from "./helpers.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

function input(changes: object = {}) {
  return {
    credentialId: randomUUID(),
    save: true,
    provider: "openai",
    label: "Personal",
    apiKey: "fixture-secret-canary-1234",
    ...changes,
  };
}

describe("encrypted account credential management", () => {
  it.each(["revoke", "clear"] as const)(
    "keeps shared credential IDs private across accounts and %s operations",
    async (deletion) => {
      const api = await harness.createAuthenticatedApi();
      const owner = await harness.account(api);
      const caller = await harness.account(api);
      const ownerInput = input({ label: "Owner", apiKey: "owner-fixture-key-A123" });
      const callerInput = input({
        credentialId: ownerInput.credentialId.toUpperCase(),
        provider: "google",
        label: "Caller",
        apiKey: "caller-fixture-key-B456",
      });
      const original = await harness.post(api, owner.cookie, "/credentials", ownerInput);
      expect(original.statusCode).toBe(201);
      const ownerMetadata = credentialMetadataSchema.parse(original.json());
      const control = await harness.post(api, caller.cookie, "/credentials", input());
      expect(control.statusCode).toBe(201);
      const shared = await harness.post(api, caller.cookie, "/credentials", callerInput);
      expect(shared.statusCode, shared.body).toBe(201);
      expect(credentialMetadataSchema.parse(shared.json())).toMatchObject({
        credentialId: ownerInput.credentialId,
        provider: "google",
        label: "Caller",
        maskedSuffix: "B456",
      });
      const duplicate = await harness.post(api, caller.cookie, "/credentials", {
        ...callerInput,
        credentialId: ownerInput.credentialId,
        provider: "anthropic",
        apiKey: "replacement-fixture-key-C789",
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ code: "CREDENTIAL_CONFLICT" });

      const records = await api.database.db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.id, ownerInput.credentialId));
      expect(records).toHaveLength(2);
      const cipher = createCredentialCipher({
        keyId: "integration-fixture",
        key: Buffer.alloc(32, 7).toString("base64"),
      });
      for (const record of records) {
        const { version, keyId, nonce, authTag, ciphertext } = record;
        const envelope = { version, keyId, nonce, authTag, ciphertext };
        const context = {
          userId: record.userId,
          provider: record.provider,
          credentialId: record.id,
        };
        expect(cipher.decrypt(context, envelope)).toBe(
          record.userId === owner.principal.userId ? ownerInput.apiKey : callerInput.apiKey,
        );
        expect(() =>
          cipher.decrypt(
            {
              ...context,
              userId:
                record.userId === owner.principal.userId
                  ? caller.principal.userId
                  : owner.principal.userId,
            },
            envelope,
          ),
        ).toThrow("CREDENTIAL_UNAVAILABLE");
      }

      const deleteInput =
        deletion === "revoke" ? { credentialId: callerInput.credentialId } : { confirm: true };
      expect(
        (await harness.post(api, caller.cookie, `/credentials/${deletion}`, deleteInput))
          .statusCode,
      ).toBe(200);
      expect(
        credentialListResponseSchema.parse(
          (await api.app.inject({ url: "/credentials", headers: { cookie: owner.cookie } })).json(),
        ),
      ).toEqual({ credentials: [ownerMetadata] });
      // The caller's outcome is identical whether the foreign record exists or has been revoked.
      expect((await harness.post(api, caller.cookie, "/credentials", callerInput)).statusCode).toBe(
        201,
      );
      expect(
        (
          await harness.post(api, caller.cookie, "/credentials/revoke", {
            credentialId: callerInput.credentialId,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await harness.post(api, owner.cookie, "/credentials/revoke", {
            credentialId: ownerInput.credentialId,
          })
        ).statusCode,
      ).toBe(200);
      expect((await harness.post(api, caller.cookie, "/credentials", callerInput)).statusCode).toBe(
        201,
      );
    },
  );

  it("persists only ciphertext and bounded metadata, binds its context and cascades only its owner's rows", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const other = await harness.account(api);
    const body = input();
    expect((await harness.post(api, account.cookie, "/credentials", body)).statusCode).toBe(201);
    expect((await harness.post(api, other.cookie, "/credentials", input())).statusCode).toBe(201);
    const [stored] = await api.database.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, body.credentialId));
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain("canary");
    const { id, userId, provider, version, keyId, nonce, authTag, ciphertext } = stored!;
    const cipher = createCredentialCipher({
      keyId: "integration-fixture",
      key: Buffer.alloc(32, 7).toString("base64"),
    });
    const envelope = { version, keyId, nonce, authTag, ciphertext };
    expect(cipher.decrypt({ credentialId: id, userId, provider }, envelope)).toBe(body.apiKey);
    expect(() =>
      cipher.decrypt({ credentialId: id, userId: other.principal.userId, provider }, envelope),
    ).toThrow("CREDENTIAL_UNAVAILABLE");
    for (const changes of [
      { provider: "evil" },
      { userId: randomUUID() },
      { version: 2 },
      { nonce: "00" },
      { authTag: "00" },
      { ciphertext: "plaintext-key-canary" },
      { label: "x".repeat(65) },
      { maskedSuffix: "entire-key-canary" },
    ]) {
      await expect(
        api.database.db
          .insert(providerCredentials)
          .values({ ...stored!, id: randomUUID(), ...changes }),
      ).rejects.toThrow();
    }
    await api.database.db.delete(authUsers).where(eq(authUsers.id, account.principal.userId));
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, account.principal.userId),
      ),
    ).toBe(0);
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, other.principal.userId),
      ),
    ).toBe(1);
  });

  it("keeps list and deletion available after key loss and does not decrypt malformed stored envelopes", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const body = input();
    expect((await harness.post(api, account.cookie, "/credentials", body)).statusCode).toBe(201);
    await api.database.db
      .update(providerCredentials)
      .set({ ciphertext: "aa", keyId: "lost-key" })
      .where(eq(providerCredentials.id, body.credentialId));
    const disabled = await harness.createAuthenticatedApi({
      credentials: (database) => createCredentialService(createCredentialRepository(database)),
    });
    const failed = await harness.post(disabled, account.cookie, "/credentials", input());
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("canary");
    const list = await disabled.app.inject({
      url: "/credentials",
      headers: { cookie: account.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(credentialListResponseSchema.parse(list.json()).credentials).toHaveLength(1);
    expect(
      (
        await harness.post(disabled, account.cookie, "/credentials/revoke", {
          credentialId: body.credentialId,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await harness.post(disabled, account.cookie, "/credentials/clear", { confirm: true }))
        .statusCode,
    ).toBe(200);
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, account.principal.userId),
      ),
    ).toBe(0);
  });

  it("enforces the bounded account list when two sessions race the final available slot", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const otherSession = await account.anotherSession();
    const body = input();
    expect((await harness.post(api, account.cookie, "/credentials", body)).statusCode).toBe(201);
    const [stored] = await api.database.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, body.credentialId));
    await api.database.db
      .insert(providerCredentials)
      .values(Array.from({ length: 98 }, () => ({ ...stored!, id: randomUUID() })));
    const results = await Promise.all([
      harness.post(api, account.cookie, "/credentials", input()),
      harness.post(api, otherSession.cookie, "/credentials", input()),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({
      code: "CREDENTIAL_LIMIT_REACHED",
    });
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, account.principal.userId),
      ),
    ).toBe(100);
    expect(
      credentialListResponseSchema.parse(
        (await api.app.inject({ url: "/credentials", headers: { cookie: account.cookie } })).json(),
      ).credentials,
    ).toHaveLength(100);
  });

  it("rejects queued management after session revocation and rolls back deletion after a row wait outlasts the session", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const second = await account.anotherSession();
    const body = input();
    expect((await harness.post(api, account.cookie, "/credentials", body)).statusCode).toBe(201);
    const repository = createCredentialRepository(api.database);
    let queued: ReturnType<typeof repository.clear> | undefined;
    async function waitForBlocker(
      tx: Parameters<Parameters<typeof api.database.db.transaction>[0]>[0],
      pid: number,
    ) {
      await expect
        .poll(async () => {
          await tx.execute(sql`select pg_stat_clear_snapshot()`);
          const result = await tx.execute<{ count: number }>(
            sql`select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
          );
          return result.rows[0]!.count;
        })
        .toBeGreaterThan(0);
    }
    await api.database.db.transaction(async (tx) => {
      const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, account.principal.userId))
        .for("update");
      queued = repository.clear(account.principal);
      await waitForBlocker(tx, result.rows[0]!.pid);
      await tx.delete(authSessions).where(eq(authSessions.id, account.principal.sessionId));
    });
    expect(await queued).toBeUndefined();
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.id, body.credentialId),
      ),
    ).toBe(1);
    await api.database.db.transaction(async (tx) => {
      const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.id, body.credentialId))
        .for("update");
      queued = repository.clear(second.principal);
      await waitForBlocker(tx, result.rows[0]!.pid);
      await tx
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(authSessions.id, second.principal.sessionId));
    });
    expect(await queued).toBeUndefined();
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.id, body.credentialId),
      ),
    ).toBe(1);
  });

  it("saves explicitly, lists only masked metadata across sessions and never reveals a key", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api, false);
    const second = await account.anotherSession();
    const body = input();
    const saved = await harness.post(api, account.cookie, "/credentials", body);
    expect(saved.statusCode, saved.body).toBe(201);
    const metadata = credentialMetadataSchema.parse(saved.json());
    expect(metadata).toMatchObject({
      credentialId: body.credentialId,
      provider: "openai",
      label: "Personal",
      maskedSuffix: "1234",
    });
    const list = await api.app.inject({ url: "/credentials", headers: { cookie: second.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.headers["referrer-policy"]).toBe("no-referrer");
    expect(credentialListResponseSchema.parse(list.json())).toEqual({ credentials: [metadata] });
    expect(saved.body + list.body).not.toContain("canary");
    for (const url of [
      `/credentials/${body.credentialId}`,
      `/credentials/${body.credentialId}/reveal`,
    ]) {
      expect((await api.app.inject({ url, headers: { cookie: account.cookie } })).statusCode).toBe(
        404,
      );
    }
    for (const apiKey of ["a", "1234", "12345678", "fixture-key-<x/>"]) {
      const response = await harness.post(
        api,
        account.cookie,
        "/credentials",
        input({ apiKey, label: "Work" }),
      );
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({ maskedSuffix: null });
    }
  });

  it("denies guests, stale sessions, foreign metadata and stale-account assertions without falling back", async () => {
    const api = await harness.createAuthenticatedApi();
    const a = await harness.account(api);
    const b = await harness.account(api);
    const guest = await harness.guest(api);
    const body = input();
    expect((await harness.post(api, a.cookie, "/credentials", body)).statusCode).toBe(201);
    for (const cookie of ["", guest.cookie, "__Secure-neurochess.session_token=forged-canary"]) {
      expect((await api.app.inject({ url: "/credentials", headers: { cookie } })).statusCode).toBe(
        401,
      );
      for (const [url, payload] of [
        ["/credentials", input()],
        ["/credentials/revoke", { credentialId: body.credentialId }],
        ["/credentials/clear", { confirm: true }],
      ] as const) {
        expect((await harness.post(api, cookie, url, payload)).statusCode).toBe(401);
      }
    }
    expect(
      (await api.app.inject({ url: "/credentials", headers: { cookie: b.cookie } })).json(),
    ).toEqual({ credentials: [] });
    expect(
      (
        await harness.post(api, b.cookie, "/credentials/revoke", {
          credentialId: body.credentialId,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await harness.post(api, b.cookie, "/credentials/clear", { confirm: true })).statusCode,
    ).toBe(200);
    for (const method of ["GET", "POST"] as const) {
      const response = await api.app.inject({
        method,
        url: "/credentials",
        headers: {
          origin: WEB_ORIGIN,
          cookie: b.cookie,
          "x-neurochess-expected-account": a.principal.userId,
        },
        ...(method === "POST" ? { payload: input() } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    expect(
      credentialListResponseSchema.parse(
        (await api.app.inject({ url: "/credentials", headers: { cookie: a.cookie } })).json(),
      ).credentials,
    ).toHaveLength(1);
    await harness.post(api, a.cookie, "/api/auth/sign-out", {});
    const cookie = `${a.cookie}; ${guest.cookie}`;
    expect((await api.app.inject({ url: "/credentials", headers: { cookie } })).statusCode).toBe(
      401,
    );
    expect((await harness.post(api, cookie, "/credentials", input())).statusCode).toBe(401);
  });

  it("rejects duplicate saves without overwriting and makes revoke/clear repeatable and scoped", async () => {
    const api = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const other = await harness.account(api);
    const body = input();
    const results = await Promise.all([
      harness.post(api, account.cookie, "/credentials", body),
      harness.post(api, account.cookie, "/credentials", body),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      (
        await harness.post(api, account.cookie, "/credentials", {
          ...body,
          apiKey: "replacement-canary-5678",
        })
      ).statusCode,
    ).toBe(409);
    const list = credentialListResponseSchema.parse(
      (await api.app.inject({ url: "/credentials", headers: { cookie: account.cookie } })).json(),
    );
    expect(list.credentials).toHaveLength(1);
    expect(list.credentials[0]?.maskedSuffix).toBe("1234");
    expect((await harness.post(api, account.cookie, "/credentials", input())).statusCode).toBe(201);
    expect((await harness.post(api, other.cookie, "/credentials", input())).statusCode).toBe(201);
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await harness.post(api, account.cookie, "/credentials/revoke", {
            credentialId: body.credentialId,
          })
        ).json(),
      ).toEqual({ status: "deleted" });
    }
    for (let i = 0; i < 2; i++) {
      expect(
        (await harness.post(api, account.cookie, "/credentials/clear", { confirm: true })).json(),
      ).toEqual({ status: "deleted" });
    }
    expect(
      (await api.app.inject({ url: "/credentials", headers: { cookie: account.cookie } })).json(),
    ).toEqual({ credentials: [] });
    expect(
      credentialListResponseSchema.parse(
        (await api.app.inject({ url: "/credentials", headers: { cookie: other.cookie } })).json(),
      ).credentials,
    ).toHaveLength(1);
  });

  it("clears earlier concurrent saves and preserves later saves across API instances", async () => {
    const api = await harness.createAuthenticatedApi();
    const otherApi = await harness.createAuthenticatedApi();
    const account = await harness.account(api);
    const second = await account.anotherSession();
    for (const saveFirst of [true, false]) {
      const body = input();
      const save = () => harness.post(otherApi, second.cookie, "/credentials", body);
      const clear = () =>
        harness.post(api, account.cookie, "/credentials/clear", { confirm: true });
      const operations: ReturnType<typeof save>[] = [];
      await api.database.db.transaction(async (tx) => {
        const result = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await tx
          .select()
          .from(authUsers)
          .where(eq(authUsers.id, account.principal.userId))
          .for("update");
        for (const operation of saveFirst ? [save, clear] : [clear, save]) {
          operations.push(operation());
          await expect
            .poll(async () => {
              await tx.execute(sql`select pg_stat_clear_snapshot()`);
              const waiting = await tx.execute<{ count: number }>(sql`
                with recursive blocked as (
                  select pid from pg_stat_activity where ${result.rows[0]!.pid} = any(pg_blocking_pids(pid))
                  union
                  select activity.pid from pg_stat_activity activity
                    join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
                ) select count(*)::int as count from blocked`);
              return waiting.rows[0]!.count;
            })
            .toBe(operations.length);
        }
      });
      expect((await Promise.all(operations)).map((response) => response.statusCode).sort()).toEqual(
        [200, 201],
      );
      const response = await api.app.inject({
        url: "/credentials",
        headers: { cookie: account.cookie },
      });
      const ids = credentialListResponseSchema
        .parse(response.json())
        .credentials.map((credential) => credential.credentialId);
      expect(ids).toEqual(saveFirst ? [] : [body.credentialId]);
    }
  });

  it("rejects untrusted origins, input/query injection and oversized bodies with secret-free logs/errors", async () => {
    const logs: string[] = [];
    const api = await harness.createAuthenticatedApi({
      logger: {
        ...createLoggerOptions("info"),
        stream: { write: (chunk: string) => logs.push(chunk) },
      },
    });
    const account = await harness.account(api);
    for (const url of ["/credentials", "/credentials/revoke", "/credentials/clear"]) {
      for (const origin of [undefined, "https://evil.example"]) {
        const response = await api.app.inject({
          method: "POST",
          url,
          payload: input(),
          headers: { cookie: account.cookie, ...(origin ? { origin } : {}) },
        });
        expect(response.statusCode).toBe(403);
      }
    }
    for (const changes of [
      { save: false },
      { save: undefined },
      { ownerUserId: account.principal.userId },
      { apiKey: "bad\nkey-canary" },
      { label: "fixture-secret-canary-1234" },
      { apiKey: "oversized-canary".repeat(3000) },
    ]) {
      const response = await harness.post(api, account.cookie, "/credentials", input(changes));
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("canary");
    }
    expect((await harness.post(api, account.cookie, "/credentials/clear", {})).statusCode).toBe(
      400,
    );
    expect(
      (
        await harness.post(api, account.cookie, "/credentials/revoke", {
          credentialId: "key-canary",
        })
      ).statusCode,
    ).toBe(400);
    const response = await api.app.inject({
      url: "/credentials?apiKey=query-secret-canary",
      headers: { cookie: account.cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body + logs.join("")).not.toContain("canary");
    expect(
      (await api.app.inject({ url: "/credentials", headers: { cookie: account.cookie } })).json(),
    ).toEqual({ credentials: [] });
  });
});
