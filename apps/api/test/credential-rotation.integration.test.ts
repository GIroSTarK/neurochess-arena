import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

import { createDatabase, type DatabaseConnection, providerCredentials } from "@neurochess/database";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";

import { testDatabaseUrl } from "../../../test/database.js";
import { createCredentialCipher } from "../src/credentials/crypto.js";
import { maintainCredentials } from "../src/credentials/rotation.js";

const manifest = {
  confirm: "rotate-provider-credentials-v1",
  old: { keyId: "rotation-old", key: randomBytes(32).toString("base64") },
  next: { keyId: "rotation-next", key: randomBytes(32).toString("base64") },
};
const oldCipher = createCredentialCipher(manifest.old);
const nextCipher = createCredentialCipher(manifest.next);
const plaintext = "synthetic-rotation-key-canary-1234";
let database: DatabaseConnection;
let schema: string;

beforeEach(async () => {
  schema = `nc_rotation_${randomUUID().replaceAll("-", "")}`;
  const setup = createDatabase(testDatabaseUrl());
  try {
    await setup.db.execute(sql`create schema ${sql.identifier(schema)}`);
    await setup.db.execute(sql`create table ${sql.identifier(schema)}.provider_credentials
      (like public.provider_credentials including all)`);
  } finally {
    await setup.close();
  }
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("options", `-csearch_path=${schema}`);
  database = createDatabase(url.toString());
});

afterEach(async () => {
  await database.close();
  const cleanup = createDatabase(testDatabaseUrl());
  try {
    await cleanup.db.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
  } finally {
    await cleanup.close();
  }
});

async function seed(count = 3) {
  const id = randomUUID();
  await database.db.insert(providerCredentials).values(
    Array.from({ length: count }, (_, index) => {
      const context = {
        credentialId: id,
        userId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        provider: "openai",
      };
      return {
        id,
        userId: context.userId,
        provider: context.provider,
        label: `Fixture ${index}`,
        maskedSuffix: "1234",
        ...oldCipher.encrypt(context, plaintext),
      };
    }),
  );
}

function rows() {
  return database.db.select().from(providerCredentials).orderBy(asc(providerCredentials.userId));
}

it("rotates every batch and owner-scoped ID, verifies readback and preserves metadata", async () => {
  await seed(251);
  const before = await rows();
  expect(await maintainCredentials(database, manifest, "verify-old")).toBe(251);
  expect(await rows()).toEqual(before);
  expect(await maintainCredentials(database, manifest, "rotate")).toBe(251);
  expect(await maintainCredentials(database, manifest, "verify-new")).toBe(251);
  const after = await rows();
  for (const [index, row] of after.entries()) {
    const previous = before[index]!;
    expect(row).toMatchObject({
      id: previous.id,
      userId: previous.userId,
      provider: previous.provider,
      label: previous.label,
      maskedSuffix: previous.maskedSuffix,
      createdAt: previous.createdAt,
      keyId: "rotation-next",
    });
    const context = { ...row, credentialId: row.id };
    const identity = { userId: context.userId, provider: context.provider, credentialId: row.id };
    const envelope = {
      version: row.version,
      keyId: row.keyId,
      nonce: row.nonce,
      authTag: row.authTag,
      ciphertext: row.ciphertext,
    };
    expect(nextCipher.decrypt(identity, envelope)).toBe(plaintext);
    expect(() => oldCipher.decrypt(identity, envelope)).toThrow("CREDENTIAL_UNAVAILABLE");
    expect(row.nonce).not.toBe(previous.nonce);
  }
  await expect(maintainCredentials(database, manifest, "rotate")).rejects.toThrow(
    "CREDENTIAL_MAINTENANCE_FAILED",
  );
  expect(await rows()).toEqual(after);
  expect(await maintainCredentials(database, manifest, "rollback")).toBe(251);
  expect(await maintainCredentials(database, manifest, "verify-old")).toBe(251);
});

it("rolls back earlier writes if a later row cannot authenticate and emits no secret", async () => {
  await seed();
  const second = (await rows())[1]!;
  await database.db
    .update(providerCredentials)
    .set({ authTag: "00".repeat(16) })
    .where(eq(providerCredentials.userId, second.userId));
  const before = await rows();
  await expect(maintainCredentials(database, manifest, "rotate")).rejects.toEqual(
    new Error("CREDENTIAL_MAINTENANCE_FAILED"),
  );
  expect(await rows()).toEqual(before);
});

it("refuses malformed keys, reused IDs/material and unknown modes before writing", async () => {
  await seed();
  const before = await rows();
  for (const input of [
    { ...manifest, confirm: "wrong" },
    { ...manifest, old: { ...manifest.old, key: plaintext } },
    { ...manifest, next: { ...manifest.next, keyId: manifest.old.keyId } },
    { ...manifest, next: { ...manifest.next, key: manifest.old.key } },
    { ...manifest, extra: plaintext },
  ]) {
    await expect(maintainCredentials(database, input, "rotate")).rejects.toEqual(
      new Error("CREDENTIAL_MAINTENANCE_FAILED"),
    );
  }
  await expect(maintainCredentials(database, manifest, plaintext)).rejects.toEqual(
    new Error("CREDENTIAL_MAINTENANCE_FAILED"),
  );
  expect(await rows()).toEqual(before);
});

it("refuses another connected client and accepts an empty table without fabricating state", async () => {
  const other = createDatabase(testDatabaseUrl());
  try {
    await other.check();
    await expect(maintainCredentials(database, manifest, "rotate")).rejects.toEqual(
      new Error("CREDENTIAL_MAINTENANCE_FAILED"),
    );
  } finally {
    await other.close();
  }
  expect(await maintainCredentials(database, manifest, "verify-old")).toBe(0);
  expect(await maintainCredentials(database, manifest, "verify-new")).toBe(0);
});

it("leaves all rows on the old key when database execution is interrupted after a partial update", async () => {
  await seed();
  const before = await rows();
  await database.db.execute(sql`
    create function pause_rotation() returns trigger language plpgsql as $$
    begin
      if new.user_id = '00000000-0000-4000-8000-000000000001' then perform pg_sleep(10); end if;
      return new;
    end $$
  `);
  await database.db.execute(sql`
    create trigger pause_rotation before update on provider_credentials
    for each row execute function pause_rotation()
  `);
  const pid = (await database.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))
    .rows[0]!.pid;
  const observerUrl = new URL(testDatabaseUrl());
  observerUrl.pathname = "/postgres";
  const observer = createDatabase(observerUrl.toString());
  const result = maintainCredentials(database, manifest, "rotate").catch((error: unknown) => error);
  try {
    const deadline = Date.now() + 5000;
    let sleeping = false;
    while (Date.now() < deadline) {
      const activity = await observer.db.execute<{ waiting: boolean }>(sql`
        select wait_event = 'PgSleep' as waiting from pg_stat_activity where pid = ${pid}
      `);
      if (activity.rows[0]?.waiting) {
        sleeping = true;
        break;
      }
      await setTimeout(20);
    }
    expect(sleeping).toBe(true);
    await observer.db.execute(sql`select pg_cancel_backend(${pid})`);
    expect(await result).toEqual(new Error("CREDENTIAL_MAINTENANCE_FAILED"));
    expect(await rows()).toEqual(before);
    expect(await maintainCredentials(database, manifest, "verify-old")).toBe(3);
  } finally {
    await observer.close();
    await result;
  }
});
