import { randomUUID } from "node:crypto";

import { analysisWriteResponseSchema, gameSnapshotSchema } from "@neurochess/contracts";
import { authSessions, games } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { analysisSample } from "./analysis-helpers.js";
import { WEB_ORIGIN } from "./helpers.js";
import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(() => harness.dispose());

it("retains private samples across independent API instances without changing canonical game data", async () => {
  const { api, owner, snapshot } = await harness.room();
  const sample = analysisSample(snapshot, 1);
  const before = await api.repository.read((reader) => reader.getGame(snapshot.gameId));
  const url = `/games/${snapshot.gameId}/analysis`;
  const saved = await harness.post(api, owner.cookie, url, { samples: [sample] });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.headers["cache-control"]).toBe("no-store");
  const savedBody = analysisWriteResponseSchema.parse(saved.json());
  expect(savedBody).toMatchObject({
    gameId: snapshot.gameId,
    samples: [sample],
  });
  const other = await harness.createAuthenticatedApi();
  const loaded = await other.app.inject({ url, headers: { cookie: owner.cookie } });
  expect(loaded.statusCode, loaded.body).toBe(200);
  expect(loaded.headers["cache-control"]).toBe("no-store");
  expect(loaded.json()).toEqual({ ...savedBody, nextCursor: null });
  expect(await api.repository.read((reader) => reader.getGame(snapshot.gameId))).toEqual(before);
});

it("keeps each room participant's evaluations private and converges on the first deepest sample", async () => {
  const { api, owner, opponent, snapshot } = await harness.room();
  const url = `/games/${snapshot.gameId}/analysis`;
  const sample = analysisSample(snapshot);
  const first = await harness.post(api, owner.cookie, url, { samples: [sample] });
  expect(first.statusCode).toBe(200);
  const retained = analysisWriteResponseSchema.parse(first.json());
  for (const depth of [sample.depth, sample.depth - 1]) {
    const loser = await harness.post(api, owner.cookie, url, {
      samples: [{ ...sample, depth, score: { kind: "cp", value: -100 }, durationMs: 1000 }],
    });
    expect(loser.json()).toEqual(retained);
  }
  expect((await harness.post(api, owner.cookie, url, { samples: [sample] })).json()).toEqual(
    retained,
  );
  const peerRead = await api.app.inject({ url, headers: { cookie: opponent.cookie } });
  expect(peerRead.json()).toEqual({ gameId: snapshot.gameId, samples: [], nextCursor: null });
  const peer = { ...sample, score: { kind: "cp", value: -42 } };
  expect((await harness.post(api, opponent.cookie, url, { samples: [peer] })).statusCode).toBe(200);
  const deeper = { ...sample, depth: 18, score: { kind: "cp", value: 0 } };
  expect((await harness.post(api, owner.cookie, url, { samples: [deeper] })).json()).toMatchObject({
    samples: [deeper],
  });
  expect(
    (await api.app.inject({ url, headers: { cookie: opponent.cookie } })).json(),
  ).toMatchObject({ samples: [peer] });
});

it("denies anonymous, guest, outsider, wrong-account, incomplete-profile and expired-session requests", async () => {
  const { api, owner, snapshot } = await harness.room();
  const outsider = await harness.account(api);
  const incomplete = await harness.account(api, false);
  const guest = await harness.guest(api);
  const url = `/games/${snapshot.gameId}/analysis`;
  for (const [cookie, status, extra] of [
    ["", 401, {}],
    [guest.cookie, 401, {}],
    [outsider.cookie, 404, {}],
    [incomplete.cookie, 403, {}],
    [owner.cookie, 401, { "x-neurochess-expected-account": outsider.principal.userId }],
    [`${outsider.cookie}; ${guest.cookie}`, 404, { "x-neurochess-identity": "guest" }],
  ] as const) {
    for (const method of ["GET", "POST"] as const) {
      const response = await api.app.inject({
        method,
        url,
        headers: { origin: WEB_ORIGIN, cookie, ...extra },
        ...(method === "POST" ? { payload: { samples: [analysisSample(snapshot)] } } : {}),
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.body).not.toContain(snapshot.fen);
    }
  }
  await api.database.db
    .update(authSessions)
    .set({ expiresAt: new Date(0) })
    .where(eq(authSessions.id, owner.principal.sessionId));
  expect((await api.app.inject({ url, headers: { cookie: owner.cookie } })).statusCode).toBe(401);
  expect(
    (await harness.post(api, owner.cookie, url, { samples: [analysisSample(snapshot)] }))
      .statusCode,
  ).toBe(401);
});

it("requires the exact write Origin and rejects Sandbox, guest games and deleted games", async () => {
  const api = await harness.createAuthenticatedApi();
  const owner = await harness.account(api);
  const { snapshot } = await harness.createGame(api, owner.cookie);
  const url = `/games/${snapshot.gameId}/analysis`;
  for (const origin of [undefined, "https://foreign.example", `${WEB_ORIGIN}/`]) {
    expect(
      (
        await api.app.inject({
          method: "POST",
          url,
          headers: { cookie: owner.cookie, ...(origin ? { origin } : {}) },
          payload: { samples: [analysisSample(snapshot)] },
        })
      ).statusCode,
    ).toBe(403);
  }
  const guest = await harness.guest(api);
  const sandbox = await harness.post(api, guest.cookie, "/sandbox/games", {});
  expect(sandbox.statusCode, sandbox.body).toBe(201);
  const guestGame = await harness.createGame(api, guest.cookie);
  for (const gameId of [
    gameSnapshotSchema.parse(sandbox.json()).gameId,
    guestGame.snapshot.gameId,
    randomUUID(),
  ]) {
    const path = `/games/${gameId}/analysis`;
    expect(
      (await api.app.inject({ url: path, headers: { cookie: `${owner.cookie}; ${guest.cookie}` } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await harness.post(api, owner.cookie, path, { samples: [analysisSample(snapshot)] }))
        .statusCode,
    ).toBe(404);
  }
  await api.database.db.delete(games).where(eq(games.id, snapshot.gameId));
  expect(
    (await harness.post(api, owner.cookie, url, { samples: [analysisSample(snapshot)] }))
      .statusCode,
  ).toBe(404);
});

it("validates the entire batch against accepted history including initial and mate positions", async () => {
  const { api, owner, snapshot } = await harness.room();
  const url = `/games/${snapshot.gameId}/analysis`;
  const initial = analysisSample(snapshot);
  const mate = {
    ...analysisSample(snapshot, 4),
    depth: 0,
    score: { kind: "mate", winner: "black", moves: 0 },
  };
  for (const invalid of [
    { ...initial, ply: 5 },
    { ...initial, fen: snapshot.fen },
    { ...initial, historyDigest: "0".repeat(64) },
    { ...initial, score: { kind: "mate", winner: "white", moves: 0 } },
    { ...mate, score: { kind: "mate", winner: "white", moves: 0 } },
  ]) {
    const response = await harness.post(api, owner.cookie, url, {
      samples: [analysisSample(snapshot, 1), invalid],
    });
    expect(response.statusCode, response.body).toBe(400);
    expect((await api.app.inject({ url, headers: { cookie: owner.cookie } })).json()).toMatchObject(
      { samples: [] },
    );
  }
  const response = await harness.post(api, owner.cookie, url, {
    samples: [mate, initial, analysisSample(snapshot, 1)],
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(analysisWriteResponseSchema.parse(response.json()).samples).toEqual(
    expect.arrayContaining([expect.objectContaining(mate), expect.objectContaining(initial)]),
  );
});

it("bounds batches, scalar fields, pages and bodies and rejects client authority or raw engine data", async () => {
  const { api, owner, snapshot } = await harness.room();
  const url = `/games/${snapshot.gameId}/analysis`;
  const sample = analysisSample(snapshot);
  for (const payload of [
    { samples: [] },
    { samples: [sample, sample] },
    { samples: Array.from({ length: 33 }, (_, ply) => ({ ...sample, ply })) },
    { samples: [sample], userId: owner.principal.userId },
    { samples: [sample], history: [] },
    ...[
      { pv: ["e2e4"] },
      { bestmove: "e2e4" },
      { raw: "info score cp 24" },
      { profile: { rank: 100 } },
      { recordedAt: new Date().toISOString() },
      { profileId: "a".repeat(65) },
      { profileId: "bad_profile" },
      { depth: 19 },
      { durationMs: 3001 },
      { depth: 1.5 },
      { ply: -1 },
      { score: { kind: "cp", value: 100001 } },
      { score: { kind: "cp", value: 0, winner: "white", moves: 1 } },
      { score: { kind: "mate", winner: "black", moves: 129 } },
      { score: { kind: "mate", winner: "black", moves: -1 } },
      { fen: "x".repeat(1025) },
    ].map((change) => ({ samples: [{ ...sample, ...change }] })),
  ]) {
    const response = await harness.post(api, owner.cookie, url, payload);
    expect(response.statusCode, response.body).toBe(400);
  }
  const obsolete = await harness.post(api, owner.cookie, url, {
    samples: [{ ...sample, profileId: "obsolete-profile" }],
  });
  expect(obsolete.statusCode).toBe(409);
  expect(obsolete.json()).toMatchObject({ code: "profile_obsolete" });
  for (const query of ["limit=129", "limit=0", "cursor=bad", "userId=foreign"]) {
    expect(
      (await api.app.inject({ url: `${url}?${query}`, headers: { cookie: owner.cookie } }))
        .statusCode,
    ).toBe(400);
  }
  const oversized = await api.app.inject({
    method: "POST",
    url,
    headers: { origin: WEB_ORIGIN, cookie: owner.cookie, "content-type": "application/json" },
    payload: " ".repeat(65_536) + JSON.stringify({ samples: [sample] }),
  });
  expect(oversized.statusCode).toBe(400);
});
