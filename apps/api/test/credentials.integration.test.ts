import { randomUUID } from "node:crypto";

import { credentialListResponseSchema, credentialMetadataSchema } from "@neurochess/contracts";
import { authSchema, createCredentialRepository, providerCredentials } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_COOKIE_NAME } from "../src/auth/service.js";
import { createCredentialCipher } from "../src/credentials/encryption.js";
import { createCredentialService } from "../src/credentials/service.js";
import { createLoggerOptions } from "../src/logger.js";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import { WEB_ORIGIN } from "./helpers.js";

const harness = new AccountGameHarness();
const encryption = {
  activeKeyId: "fixture",
  keys: { fixture: Buffer.alloc(32, 17).toString("base64") },
};
const createApi = (options: Parameters<AccountGameHarness["createApi"]>[0] = {}) =>
  harness.createApi({
    credentials: (db) =>
      createCredentialService(createCredentialRepository(db), createCredentialCipher(encryption)),
    ...options,
  });
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

const input = {
  save: true,
  provider: "openai",
  label: "Personal key",
  apiKey: "test-only-provider-secret-Ab12",
};

describe("private encrypted credentials", () => {
  it("saves only on explicit account opt-in and returns masked metadata across sessions", async () => {
    const api = await createApi();
    const owner = await harness.account(api, false);
    const response = await post(api, owner.cookie, "/api/credentials", input);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      provider: "openai",
      label: "Personal key",
      maskedSuffix: "Ab12",
    });
    expect(response.body).not.toContain(input.apiKey);
    expect(response.headers["cache-control"]).toBe("no-store");
    const otherSession = await harness.anotherSession(api, owner);
    const list = await get(api, otherSession.cookie, "/api/credentials");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ credentials: [response.json()], nextCursor: null });
    expect((await get(api, owner.cookie, `/api/credentials/${randomUUID()}`)).statusCode).toBe(404);
  });

  it("stores only encrypted material for every provider and creates distinct records for duplicate saves", async () => {
    const api = await createApi();
    const owner = await harness.account(api, false);
    const secondApi = await createApi();
    const secondSession = await harness.anotherSession(secondApi, owner);
    const responses = await Promise.all([
      ...["openai", "anthropic", "google", "openrouter"].map((provider) =>
        post(api, owner.cookie, "/api/credentials", { ...input, provider }),
      ),
      post(secondApi, secondSession.cookie, "/api/credentials", input),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(201);
      const metadata = credentialMetadataSchema.parse(response.json());
      expect(Object.keys(metadata).sort()).toEqual([
        "createdAt",
        "credentialId",
        "label",
        "maskedSuffix",
        "provider",
      ]);
      expect(response.body).not.toContain(owner.userId);
    }
    const stored = await api.database.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, owner.userId));
    expect(stored).toHaveLength(5);
    expect(new Set(stored.map((row) => row.id)).size).toBe(5);
    expect(new Set(stored.map((row) => row.nonce)).size).toBe(5);
    expect(JSON.stringify(stored)).not.toContain(input.apiKey);
    expect(JSON.stringify(stored)).not.toContain(encryption.keys.fixture);
    const cipher = createCredentialCipher(encryption);
    for (const row of stored) {
      expect(
        cipher.decrypt(
          { credentialId: row.id, provider: row.provider, userId: row.userId },
          {
            version: row.version,
            keyId: row.keyId,
            nonce: row.nonce,
            authTag: row.authTag,
            ciphertext: row.ciphertext,
          },
        ),
      ).toBe(input.apiKey);
    }
    for (const apiKey of ["tiny", "long-key-<>!?"]) {
      const response = await post(api, owner.cookie, "/api/credentials", { ...input, apiKey });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ maskedSuffix: null });
      expect(response.body).not.toContain(apiKey);
    }
  });

  it("denies guests, expired/forged sessions, foreign records and caller-supplied ownership", async () => {
    const api = await createApi();
    const owner = await harness.account(api, false);
    const stranger = await harness.account(api, false);
    const guest = await harness.guest(api);
    const saved = credentialMetadataSchema.parse(
      (await post(api, owner.cookie, "/api/credentials", input)).json(),
    );
    const revoke = `/api/credentials/${saved.credentialId}/revoke`;
    for (const cookie of ["", guest.cookie, `${AUTH_COOKIE_NAME}=forged; ${guest.cookie}`]) {
      expect((await get(api, cookie, "/api/credentials")).statusCode).toBe(401);
      expect((await post(api, cookie, "/api/credentials", input)).statusCode).toBe(401);
      expect((await post(api, cookie, revoke, {})).statusCode).toBe(401);
      expect(
        (await post(api, cookie, "/api/credentials/clear", { confirm: true })).statusCode,
      ).toBe(401);
    }
    expect((await get(api, stranger.cookie, "/api/credentials")).json()).toEqual({
      credentials: [],
      nextCursor: null,
    });
    expect((await post(api, stranger.cookie, revoke, {})).statusCode).toBe(404);
    for (const patch of [
      { userId: owner.userId },
      { credentialId: saved.credentialId },
      { save: false },
      { save: undefined },
    ]) {
      expect(
        (await post(api, stranger.cookie, "/api/credentials", { ...input, ...patch })).statusCode,
      ).toBe(400);
    }
    expect(
      (await get(api, stranger.cookie, `/api/credentials?userId=${owner.userId}`)).statusCode,
    ).toBe(400);
    expect((await get(api, `${guest.cookie}; ${owner.cookie}`, "/api/credentials")).json()).toEqual(
      { credentials: [saved], nextCursor: null },
    );
    await api.database.db
      .update(authSchema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSchema.session.id, owner.principal.sessionId));
    expect(
      (await get(api, `${owner.cookie}; ${guest.cookie}`, "/api/credentials")).statusCode,
    ).toBe(401);
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, owner.userId),
      ),
    ).toBe(1);
  });

  it("revokes and clears only the current account, with predictable repeat operations", async () => {
    const api = await createApi();
    const owner = await harness.account(api, false);
    const stranger = await harness.account(api, false);
    const first = credentialMetadataSchema.parse(
      (await post(api, owner.cookie, "/api/credentials", input)).json(),
    );
    await post(api, owner.cookie, "/api/credentials", input);
    const foreign = credentialMetadataSchema.parse(
      (await post(api, stranger.cookie, "/api/credentials", input)).json(),
    );
    const url = `/api/credentials/${first.credentialId}/revoke`;
    expect((await post(api, owner.cookie, url, {})).json()).toEqual({ success: true });
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.id, first.credentialId),
      ),
    ).toBe(0);
    expect((await post(api, owner.cookie, url, {})).statusCode).toBe(404);
    expect((await post(api, owner.cookie, "/api/credentials/clear", {})).statusCode).toBe(400);
    for (let n = 0; n < 2; n++) {
      expect(
        (await post(api, owner.cookie, "/api/credentials/clear", { confirm: true })).json(),
      ).toEqual({ success: true });
      expect((await get(api, owner.cookie, "/api/credentials")).json()).toEqual({
        credentials: [],
        nextCursor: null,
      });
    }
    expect((await get(api, stranger.cookie, "/api/credentials")).json()).toEqual({
      credentials: [foreign],
      nextCursor: null,
    });
  });

  it("bounds lists with scoped keyset pagination, including a deleted cursor", async () => {
    const api = await createApi();
    const owner = await harness.account(api, false);
    for (let n = 0; n < 53; n++) {
      expect((await post(api, owner.cookie, "/api/credentials", input)).statusCode).toBe(201);
    }
    const first = credentialListResponseSchema.parse(
      (await get(api, owner.cookie, "/api/credentials")).json(),
    );
    expect(first.credentials).toHaveLength(50);
    expect(first.nextCursor).toBe(first.credentials.at(-1)?.credentialId);
    if (!first.nextCursor) throw new Error("Credential cursor missing");
    await post(api, owner.cookie, `/api/credentials/${first.nextCursor}/revoke`, {});
    const second = credentialListResponseSchema.parse(
      (await get(api, owner.cookie, `/api/credentials?after=${first.nextCursor}`)).json(),
    );
    expect(second.credentials).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.credentials, ...second.credentials].map((row) => row.credentialId)).size,
    ).toBe(53);
  });

  it("keeps cleanup available without encryption keys and never decrypts management reads", async () => {
    const api = await createApi();
    const owner = await harness.account(api, false);
    const saved = credentialMetadataSchema.parse(
      (await post(api, owner.cookie, "/api/credentials", input)).json(),
    );
    const disabled = await createApi({
      credentials: (db) => createCredentialService(createCredentialRepository(db)),
    });
    const denied = await post(disabled, owner.cookie, "/api/credentials", input);
    expect(denied.statusCode).toBe(503);
    expect(denied.json()).toMatchObject({ code: "CREDENTIAL_STORAGE_DISABLED" });
    await api.database.db
      .update(providerCredentials)
      .set({ ciphertext: "00" })
      .where(eq(providerCredentials.id, saved.credentialId));
    expect((await get(disabled, owner.cookie, "/api/credentials")).json()).toEqual({
      credentials: [saved],
      nextCursor: null,
    });
    expect(
      (await post(disabled, owner.cookie, `/api/credentials/${saved.credentialId}/revoke`, {}))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(disabled, owner.cookie, "/api/credentials/clear", { confirm: true })).statusCode,
    ).toBe(200);
  });

  it("requires exact origins and JSON, bounds requests and never logs keys, cookies or exception payloads", async () => {
    const logs: string[] = [];
    const api = await createApi({
      logger: {
        ...createLoggerOptions("info"),
        stream: { write: (value: string) => logs.push(value) },
      },
    });
    const owner = await harness.account(api, false);
    for (const payload of [
      { ...input, label: input.apiKey },
      { ...input, apiKey: input.apiKey + "\n" },
      { ...input, label: "<script>" },
      { ...input, apiKey: "x".repeat(9000) },
    ]) {
      const response = await post(api, owner.cookie, "/api/credentials", payload);
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(input.apiKey);
    }
    for (const origin of [undefined, "null", "https://evil.example"]) {
      const response = await api.app.inject({
        method: "POST",
        url: "/api/credentials",
        payload: input,
        headers: { cookie: owner.cookie, ...(origin ? { origin } : {}) },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (await get(api, owner.cookie, "/api/credentials", { origin: "https://evil.example" }))
        .statusCode,
    ).toBe(403);
    for (const payload of ['{"apiKey":', input.apiKey]) {
      expect(
        (
          await api.app.inject({
            method: "POST",
            url: "/api/credentials",
            payload,
            headers: {
              cookie: owner.cookie,
              origin: WEB_ORIGIN,
              "content-type": "application/json",
            },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/api/credentials",
          payload: "{}",
          headers: { cookie: owner.cookie, origin: WEB_ORIGIN, "content-type": "text/plain" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await get(api, owner.cookie, `/api/credentials?apiKey=${input.apiKey}`)).statusCode,
    ).toBe(400);
    expect(
      (await post(api, owner.cookie, `/api/credentials/${input.apiKey}/revoke`, {})).statusCode,
    ).toBe(400);
    const failure = Object.assign(new Error(input.apiKey), {
      name: input.apiKey,
      code: input.apiKey,
      detail: input.apiKey,
    });
    vi.spyOn(api.database.db, "transaction").mockRejectedValueOnce(failure);
    const failed = await post(api, owner.cookie, "/api/credentials", input);
    expect(failed.statusCode).toBe(500);
    expect(failed.body + logs.join("")).not.toContain(input.apiKey);
    expect(logs.join("")).not.toContain(owner.token);
    expect(logs.join("")).not.toContain(encryption.keys.fixture);
  });

  it.each(["save", "list", "revoke", "clear"] as const)(
    "rechecks a revoked session after identity lock waits for %s",
    async (operation) => {
      const api = await createApi();
      const otherApi = await createApi();
      const owner = await harness.account(api, false);
      const saved = credentialMetadataSchema.parse(
        (await post(api, owner.cookie, "/api/credentials", input)).json(),
      );
      const service = createCredentialService(
        createCredentialRepository(otherApi.database),
        createCredentialCipher(encryption),
      );
      let pending: Promise<unknown> | undefined;
      await api.database.db.transaction(async (tx) => {
        await tx
          .select()
          .from(authSchema.user)
          .where(eq(authSchema.user.id, owner.userId))
          .for("update");
        const operations = {
          save: () => service.save(owner.principal, input),
          list: () => service.list(owner.principal, {}),
          revoke: () => service.revoke(owner.principal, saved.credentialId),
          clear: () => service.clear(owner.principal),
        };
        pending = operations[operation]().catch((error: unknown) => error);
        await tx
          .delete(authSchema.session)
          .where(eq(authSchema.session.id, owner.principal.sessionId));
      });
      expect(await pending).toMatchObject({ code: "CREDENTIAL_UNAUTHORIZED" });
      expect(
        await api.database.db.$count(
          providerCredentials,
          eq(providerCredentials.userId, owner.userId),
        ),
      ).toBe(1);
    },
  );

  it("rolls back an inserted credential when its session expires during a database wait", async () => {
    const api = await createApi();
    const other = await createApi();
    const owner = await harness.account(api, false);
    const service = createCredentialService(
      createCredentialRepository(other.database),
      createCredentialCipher(encryption),
    );
    let pending: Promise<unknown> | undefined;
    await api.database.db.transaction(async (tx) => {
      await tx.execute(sql`lock table provider_credentials in share mode`);
      await tx
        .update(authSchema.session)
        .set({ expiresAt: sql`(clock_timestamp() at time zone 'UTC') + interval '1.5 seconds'` })
        .where(eq(authSchema.session.id, owner.principal.sessionId));
    });
    await api.database.db.transaction(async (tx) => {
      await tx.execute(sql`lock table provider_credentials in share mode`);
      pending = service.save(owner.principal, input).catch((error: unknown) => error);
      await vi.waitFor(async () => {
        const waiting = await other.database.db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'insert into "provider_credentials"%'`,
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
      await tx.execute(sql`select pg_sleep(1.6)`);
    });
    expect(await pending).toMatchObject({ code: "CREDENTIAL_UNAUTHORIZED" });
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, owner.userId),
      ),
    ).toBe(0);
  });

  it("enforces envelope bounds and owner cascades in PostgreSQL", async () => {
    const api = await createApi();
    const owner = await harness.account(api, false);
    const saved = credentialMetadataSchema.parse(
      (await post(api, owner.cookie, "/api/credentials", input)).json(),
    );
    const [stored] = await api.database.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, saved.credentialId));
    expect(stored).toBeDefined();
    if (!stored) throw new Error("Credential fixture missing");
    for (const patch of [
      { label: "" },
      { label: " " },
      { label: "x".repeat(65) },
      { label: "bad\nlabel" },
      { maskedSuffix: "whole-key" },
      { version: 2 },
      { keyId: "x".repeat(33) },
      { nonce: "aa".repeat(11) },
      { authTag: "aa".repeat(15) },
      { ciphertext: "" },
      { ciphertext: "abc" },
      { ciphertext: "aa".repeat(4097) },
      { ciphertext: "plain-provider-key" },
      { userId: "missing-owner" },
    ]) {
      await expect(
        api.database.db
          .insert(providerCredentials)
          .values({ ...stored, ...patch, id: randomUUID() }),
      ).rejects.toThrow();
    }
    await expect(api.database.db.insert(providerCredentials).values(stored)).rejects.toThrow();
    expect(
      await api.database.db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.id, stored.id)),
    ).toEqual([stored]);
    await api.database.db.delete(authSchema.user).where(eq(authSchema.user.id, owner.userId));
    expect(
      await api.database.db.$count(
        providerCredentials,
        eq(providerCredentials.userId, owner.userId),
      ),
    ).toBe(0);
  });

  it.each(["save", "revoke", "clear"] as const)(
    "rolls back %s and discards secret-bearing diagnostics after executed SQL",
    async (operation) => {
      const logs: string[] = [];
      const api = await createApi({
        logger: {
          ...createLoggerOptions("info"),
          stream: { write: (value: string) => logs.push(value) },
        },
      });
      const owner = await harness.account(api, false);
      const first = credentialMetadataSchema.parse(
        (await post(api, owner.cookie, "/api/credentials", input)).json(),
      );
      await post(api, owner.cookie, "/api/credentials", { ...input, provider: "google" });
      const transaction = api.database.db.transaction.bind(api.database.db);
      vi.spyOn(api.database.db, "transaction").mockImplementationOnce((work) =>
        transaction(async (tx) => {
          await work(tx);
          const remaining = await tx
            .select()
            .from(providerCredentials)
            .where(eq(providerCredentials.userId, owner.userId));
          expect(remaining).toHaveLength(operation === "save" ? 3 : operation === "clear" ? 0 : 1);
          throw Object.assign(new Error(input.apiKey), { code: input.apiKey, name: input.apiKey });
        }),
      );
      const operations = {
        save: () => post(api, owner.cookie, "/api/credentials", input),
        revoke: () => post(api, owner.cookie, `/api/credentials/${first.credentialId}/revoke`, {}),
        clear: () => post(api, owner.cookie, "/api/credentials/clear", { confirm: true }),
      };
      const response = await operations[operation]();
      expect(response.statusCode).toBe(500);
      expect(response.body + logs.join("")).not.toContain(input.apiKey);
      expect(
        await api.database.db.$count(
          providerCredentials,
          eq(providerCredentials.userId, owner.userId),
        ),
      ).toBe(2);
    },
  );

  it("serializes clear and a later save across account sessions at the user lock", async () => {
    const api = await createApi();
    const second = await createApi();
    const owner = await harness.account(api, false);
    const session = await harness.anotherSession(second, owner);
    await post(api, owner.cookie, "/api/credentials", input);
    const deleted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = api.database.db.transaction.bind(api.database.db);
    vi.spyOn(api.database.db, "transaction").mockImplementationOnce((work) =>
      transaction(async (tx) => {
        const result = await work(tx);
        deleted.resolve();
        await release.promise;
        return result;
      }),
    );
    const clearing = post(api, owner.cookie, "/api/credentials/clear", { confirm: true });
    let saving: ReturnType<typeof post> | undefined;
    try {
      await deleted.promise;
      saving = post(second, session.cookie, "/api/credentials", { ...input, label: "After clear" });
      await vi.waitFor(async () => {
        const waiting = await second.database.db.execute(
          sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'select "id" from "user"%'`,
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
    } finally {
      release.resolve();
      await clearing;
    }
    expect((await saving).statusCode).toBe(201);
    const list = credentialListResponseSchema.parse(
      (await get(second, session.cookie, "/api/credentials")).json(),
    );
    expect(list.credentials).toHaveLength(1);
    expect(list.credentials[0]?.label).toBe("After clear");
  });
});
