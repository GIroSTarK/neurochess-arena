import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { createGame } from "@neurochess/chess";
import { analysisReadResponseSchema } from "@neurochess/contracts";
import { gameAnalysisSamples, gameSlots } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { currentAnalysisProfile } from "../src/analysis/profiles.js";
import { createAnalysisService } from "../src/analysis/service.js";
import { positionOf, transportSnapshot } from "../src/games/command-persistence.js";
import { createLoggerOptions } from "../src/logger.js";

import { access, aiMatch, output, service, turnCommand } from "./ai-turn-helpers.js";
import { analysisSample } from "./analysis-helpers.js";
import { gameRecords } from "./history-deletion-helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(() => harness.dispose());

it("accepts earlier history after new moves without touching execution, slots or game projections", async () => {
  const api = await harness.createAuthenticatedApi();
  const owner = await harness.account(api);
  const executor = service(api, {
    openai: createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] }),
  });
  const { snapshot } = await executor.createAi(owner.principal, aiMatch);
  const delayed = analysisSample(snapshot);
  const advanced = await executor.aiTurn(owner.principal, turnCommand(snapshot), access());
  expect(advanced.version).toBeGreaterThan(snapshot.version);
  const records = await gameRecords(api, snapshot.gameId);
  const slots = await api.database.db
    .select()
    .from(gameSlots)
    .where(eq(gameSlots.gameId, snapshot.gameId));
  const analysis = createAnalysisService(api.repository);
  expect(
    (await analysis.write(owner.principal, snapshot.gameId, { samples: [delayed] })).samples,
  ).toEqual([expect.objectContaining(delayed)]);
  expect((await analysis.read(owner.principal, snapshot.gameId, {})).samples).toHaveLength(1);
  expect(await gameRecords(api, snapshot.gameId)).toEqual(records);
  expect(
    await api.database.db.select().from(gameSlots).where(eq(gameSlots.gameId, snapshot.gameId)),
  ).toEqual(slots);
});

it("retains old labelled profiles until a current higher-rank replacement commits, regardless of depth", async () => {
  const { api, owner, snapshot } = await harness.room();
  const old = createAnalysisService(api.repository);
  const sample = { ...analysisSample(snapshot), depth: 18 };
  const saved = await old.write(owner.principal, snapshot.gameId, { samples: [sample] });
  const newer = { ...currentAnalysisProfile, id: "fixture-next-profile", rank: 2 };
  const registry = { current: newer, known: [currentAnalysisProfile, newer] };
  const current = createAnalysisService(api.repository, registry);
  expect((await current.read(owner.principal, snapshot.gameId, {})).samples).toEqual(saved.samples);
  await expect(
    current.write(owner.principal, snapshot.gameId, { samples: [sample] }),
  ).rejects.toMatchObject({ message: "profile_obsolete", currentProfileId: newer.id });
  const replacement = {
    ...sample,
    profileId: newer.id,
    depth: 1,
    score: { kind: "mate", winner: "black", moves: 2 },
  };
  const failing = createAnalysisService(
    {
      ...api.repository,
      write: (action) =>
        api.repository.write((tx) =>
          action({
            ...tx,
            saveAnalysisSample: async (value) => {
              await tx.saveAnalysisSample(value);
              throw new Error("Injected storage failure");
            },
          }),
        ),
    },
    registry,
  );
  await expect(
    failing.write(owner.principal, snapshot.gameId, { samples: [replacement] }),
  ).rejects.toThrow("Injected storage failure");
  expect((await current.read(owner.principal, snapshot.gameId, {})).samples).toEqual(saved.samples);
  const replaced = await current.write(owner.principal, snapshot.gameId, {
    samples: [replacement],
  });
  expect(replaced.samples).toEqual([expect.objectContaining(replacement)]);
  const rollbackDeployment = createAnalysisService(api.repository, {
    current: currentAnalysisProfile,
    known: registry.known,
  });
  expect(
    (await rollbackDeployment.write(owner.principal, snapshot.gameId, { samples: [sample] }))
      .samples,
  ).toEqual(replaced.samples);
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      eq(gameAnalysisSamples.gameId, snapshot.gameId),
    ),
  ).toBe(1);
});

// Recorded legal play avoids repetition and the fifty-move boundary for the pagination fixture.
const longHistory =
  `d2d3 c7c6 e2e3 f7f5 f2f3 a7a6 d1e2 a8a7 e1d2 g7g6 a2a3 d8c7 e2d1 c6c5 b2b4 e7e6 c2c4 c7e5 d1a4 f5f4 a4c2 b7b6 h2h3 a7a8 b4c5 e5f6 h1h2 f8g7 a1a2 b6c5 h2h1 f6d8 a2a1 g8e7 c2b2 e6e5 d2d1 e7d5 b2c2 d5b4 a3a4 b4c2 g1e2 c2a1 e2g3 e5e4 h1h2 d8g5 g3h1 g7d4 h1g3 d4g7 c1d2 g7c3 f3e4 g5e5 d2c1 f4g3 h2h1 e5g7 c1d2 c3a5 d3d4 a1c2 e4e5 h8f8 e3e4 f8f1 d1c2 h7h6 d2g5 g7e7 g5d2 g6g5 d2b4 h6h5 b4a5 e7d8 h1h2 f1e1 d4d5 d7d6 a5d2 e1b1 a4a5 b1b3 d2f4 c8f5 f4g3 e8d7 c2d1 b3b2 g3h4 b2b4 d1c1 b8c6 c1c2 c6a7 g2g4 b4b3 h2g2 d6e5 g4f5 b3a3 h4g5 d7e8 g5h6 a7c8 g2g4 a3e3 c2c1 d8d6 h6e3 d6f6 g4h4 f6g6 h4h5 e8d8 e3f4 d8c7 h5h4 g6g2 f4g3 a8a7 g3e1 c7b8 h4h8 g2h3 e1g3 a7g7`.split(
    " ",
  );

it("accepts 32-ply batches and pages at 128 ascending samples with account/game-bound cursors", async () => {
  const api = await harness.createAuthenticatedApi();
  const owner = await harness.account(api);
  const other = await harness.account(api);
  const { snapshot } = await harness.createGame(api, owner.cookie);
  const domain = createGame();
  domain.start();
  for (const move of longHistory) expect(domain.playMove(move).ok).toBe(true);
  const history = transportSnapshot(snapshot.gameId, longHistory.length, domain.snapshot());
  await api.repository.write(async (tx) => {
    await tx.lockAccount(owner.principal.userId);
    await tx.lockGame(snapshot.gameId);
    for (const move of history.moves) {
      const commandId = randomUUID();
      await tx.appendMove({ ...move, gameId: snapshot.gameId, version: move.ply, commandId });
      await tx.appendCommand({
        gameId: snapshot.gameId,
        version: move.ply,
        commandId,
        kind: "move",
      });
    }
    await tx.updatePosition(snapshot.gameId, snapshot.version, positionOf(history));
  });
  const url = `/games/${snapshot.gameId}/analysis`;
  const samples = Array.from({ length: 131 }, (_, ply) => analysisSample(history, ply));
  for (let offset = 0; offset < samples.length; offset += 32) {
    const saved = await harness.post(api, owner.cookie, url, {
      samples: samples.slice(offset, offset + 32).reverse(),
    });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  const first = analysisReadResponseSchema.parse(
    (await api.app.inject({ url, headers: { cookie: owner.cookie } })).json(),
  );
  expect(first.samples.map((sample) => sample.ply)).toEqual(
    Array.from({ length: 128 }, (_, ply) => ply),
  );
  expect(first.nextCursor).not.toBeNull();
  if (first.nextCursor === null) throw new Error("Missing analysis cursor");
  const nextUrl = `${url}?cursor=${first.nextCursor}`;
  const next = analysisReadResponseSchema.parse(
    (await api.app.inject({ url: nextUrl, headers: { cookie: owner.cookie } })).json(),
  );
  expect(next.samples.map((sample) => sample.ply)).toEqual([128, 129, 130]);
  expect(next.nextCursor).toBeNull();
  expect(
    (await api.app.inject({ url: nextUrl, headers: { cookie: other.cookie } })).statusCode,
  ).toBe(400);
  expect(
    (
      await api.app.inject({
        url: `/games/${randomUUID()}/analysis?cursor=${first.nextCursor}`,
        headers: { cookie: owner.cookie },
      })
    ).statusCode,
  ).toBe(400);
});

it("returns and logs safe errors when persistence fails without logging analysis or raw output", async () => {
  let logs = "";
  const sentinel = "private-engine-output-sentinel";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs += String(chunk);
      done();
    },
  });
  const api = await harness.createAuthenticatedApi({
    logger: { ...createLoggerOptions("info"), stream },
    repository: (repository) => ({
      ...repository,
      write: (action) =>
        repository.write((tx) =>
          action({
            ...tx,
            saveAnalysisSample: async () => {
              throw new Error(sentinel);
            },
          }),
        ),
    }),
  });
  const owner = await harness.account(api);
  const { snapshot } = await harness.createGame(api, owner.cookie);
  const sample = analysisSample(snapshot);
  const failed = await harness.post(api, owner.cookie, `/games/${snapshot.gameId}/analysis`, {
    samples: [sample],
  });
  expect(failed.statusCode).toBe(500);
  for (const value of [sentinel, sample.fen, sample.historyDigest, owner.cookie]) {
    expect(logs).not.toContain(value);
    expect(failed.body).not.toContain(value);
  }
  expect(
    await api.database.db.$count(
      gameAnalysisSamples,
      eq(gameAnalysisSamples.gameId, snapshot.gameId),
    ),
  ).toBe(0);
});
