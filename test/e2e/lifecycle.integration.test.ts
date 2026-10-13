import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { createGameRepository, games, guestSessions } from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { integrationDatabase } from "../database.js";

import { API_ORIGIN, DISABLED_WEB_ORIGIN, WEB_ORIGIN } from "./environment.js";
import { testTls } from "./https.js";
import { startBrowserTestServer } from "./lifecycle.js";

const defaultCertificates = getCACertificates("default");
beforeAll(() => setDefaultCACertificates([...defaultCertificates, testTls.cert.toString()]));
afterAll(() => setDefaultCACertificates(defaultCertificates));

async function isListening(origin: string): Promise<boolean> {
  const url = new URL(origin);
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

it("cleans guests with and without games, preserves unrelated data, and closes every listener", async () => {
  const database = integrationDatabase();
  const repository = createGameRepository(database);
  const unrelated = await repository.createGuest(randomBytes(32).toString("hex"), 86_400);
  const ownedIds: string[] = [];
  try {
    const stop = await startBrowserTestServer();
    try {
      for (const withGame of [false, true]) {
        const headers = { origin: WEB_ORIGIN, "content-type": "application/json" };
        const response = await fetch(API_ORIGIN + "/guest-session", {
          method: "POST",
          headers,
          body: "{}",
        });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
        expect(Boolean(cookie)).toBe(true);
        const token = cookie!.slice(cookie!.indexOf("=") + 1);
        const [guest] = await database.db
          .select({ id: guestSessions.id })
          .from(guestSessions)
          .where(eq(guestSessions.tokenHash, createHash("sha256").update(token).digest("hex")));
        expect(Boolean(guest)).toBe(true);
        ownedIds.push(guest!.id);
        if (withGame) {
          const created = await fetch(API_ORIGIN + "/sandbox/games", {
            method: "POST",
            headers: { ...headers, cookie: cookie! },
            body: "{}",
          });
          expect(created.status).toBe(201);
          await created.arrayBuffer();
        }
      }
      expect(await database.db.$count(games, inArray(games.ownerGuestSessionId, ownedIds))).toBe(1);
    } finally {
      await stop();
    }
    expect(await database.db.$count(guestSessions, inArray(guestSessions.id, ownedIds))).toBe(0);
    expect(await database.db.$count(games, inArray(games.ownerGuestSessionId, ownedIds))).toBe(0);
    expect(await database.db.$count(guestSessions, eq(guestSessions.id, unrelated.id))).toBe(1);
    for (const origin of [API_ORIGIN, WEB_ORIGIN, DISABLED_WEB_ORIGIN]) {
      expect(await isListening(origin)).toBe(false);
    }
  } finally {
    try {
      await database.db.transaction(async (tx) => {
        const ids = [...ownedIds, unrelated.id];
        await tx.delete(games).where(inArray(games.ownerGuestSessionId, ids));
        await tx.delete(guestSessions).where(inArray(guestSessions.id, ids));
      });
    } finally {
      await database.close();
    }
  }
});

it("refuses an occupied test port and closes resources from the failed startup", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(Number(new URL(API_ORIGIN).port), "localhost", resolve);
  });
  try {
    await expect(startBrowserTestServer()).rejects.toThrow(/failure/);
    expect(await isListening(API_ORIGIN)).toBe(true);
    expect(await isListening(WEB_ORIGIN)).toBe(false);
    expect(await isListening(DISABLED_WEB_ORIGIN)).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});
