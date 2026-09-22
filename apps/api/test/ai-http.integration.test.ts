import { randomUUID } from "node:crypto";

import {
  type AiGameConfiguration,
  gameDetailsSchema,
  gameInvocationsSchema,
  gameSnapshotSchema,
  type ModelDiscoveryResult,
} from "@neurochess/contracts";
import {
  aiTurnReservations,
  aiTurns,
  gameCommands,
  gameParticipants,
  games,
  modelInvocations,
  moves,
} from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createLoggerOptions } from "../src/logger.js";

import { aiMatch, control, output, turnCommand } from "./ai-turn-helpers.js";
import {
  ApiHarness,
  claimController,
  command,
  createSandbox,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { turnCatalog } from "./providers/turn-catalog.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
const apiKey = "http-key-sentinel-not-a-real-credential";
const catalog = () => ({ ok: true, models: turnCatalog("openai") }) as const;
const configuration: AiGameConfiguration = {
  mode: "ai_vs_ai",
  seats: { white: aiMatch.seats.white, black: aiMatch.seats.white },
};

function post(api: TestApi, guest: TestGuest, url: string, payload: unknown) {
  return api.app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}
function get(api: TestApi, guest: TestGuest, url: string) {
  return api.app.inject({ method: "GET", url, headers: { cookie: guest.cookie } });
}
async function create(api: TestApi, guest: TestGuest, config = configuration) {
  const response = await post(api, guest, "/games", config);
  expect(response.statusCode, response.body).toBe(201);
  const details = gameDetailsSchema.parse(response.json());
  await claimController(api, guest, details.snapshot);
  return details;
}

describe("protected discovery and ordinary AI HTTP operations", () => {
  it.each(["discovery", "inference"] as const)(
    "turn deadline cancels %s and commits a provider pause",
    async (stage) => {
      const waitForAbort = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error(apiKey), { code: apiKey })),
            { once: true },
          );
        });
      const adapter = createScriptedAdapter({
        provider: "openai",
        models: [stage === "discovery" ? ({ signal }) => waitForAbort(signal) : catalog()],
        moves: [({ signal }) => waitForAbort(signal)],
      });
      const api = await harness.createApi({
        aiAdapters: { openai: adapter },
        providerTimeouts: { turnMs: 150 },
      });
      const guest = await harness.guest(api);
      const { snapshot } = await create(api, guest);
      const response = await post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
        ...turnCommand(snapshot),
        apiKey,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        state: "paused",
        terminationReason: null,
        moves: [],
      });
      const records = gameInvocationsSchema.parse(
        (await get(api, guest, `/games/${snapshot.gameId}/invocations`)).json(),
      );
      expect(records.turns[0]).toMatchObject({
        invalidOutputCount: 0,
        attempts: [{ error: { code: "provider_timeout" } }],
      });
      expect(adapter.moveCalls).toBe(stage === "discovery" ? 0 : 1);
    },
  );

  it("cancels a disconnected HTTP turn and persists a pause without retrying inference", async () => {
    const entered = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [catalog()],
      moves: [
        ({ signal }) => {
          entered.resolve();
          return new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error(apiKey)), { once: true }),
          );
        },
      ],
    });
    const api = await harness.createApi({
      aiAdapters: { openai: adapter },
      repository: (repository) => ({
        ...repository,
        async write(action) {
          let paused = false;
          const result = await repository.write((tx) =>
            action({
              ...tx,
              async appendCommand(command) {
                await tx.appendCommand(command);
                if (command.kind === "pause") paused = true;
              },
            }),
          );
          if ((() => paused)()) finished.resolve();
          return result;
        },
      }),
    });
    const guest = await harness.guest(api);
    const { snapshot } = await create(api, guest);
    const address = await api.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const pending = fetch(`${address}/games/${snapshot.gameId}/ai-turn`, {
      method: "POST",
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...turnCommand(snapshot), apiKey }),
      signal: controller.signal,
    }).catch(() => undefined);
    await entered.promise;
    controller.abort();
    await pending;
    await finished.promise;
    const records = gameInvocationsSchema.parse(
      (await get(api, guest, `/games/${snapshot.gameId}/invocations`)).json(),
    );
    expect(records.turns[0]?.attempts[0]).toMatchObject({
      error: { code: "provider_unavailable", reason: "cancelled" },
    });
    expect((await get(api, guest, `/games/${snapshot.gameId}`)).json()).toMatchObject({
      state: "paused",
      moves: [],
    });
    expect(adapter.moveCalls).toBe(1);
  });

  it("discovers, creates and plays with fresh capabilities, persists only effective parameters, and keeps every private record credential-free", async () => {
    const logs: string[] = [];
    const changed = turnCatalog("openai");
    changed[0]!.capabilities.parameters.temperature = null;
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [catalog(), { ok: true, models: changed }, catalog()],
      moves: [
        (input) => {
          expect(input.apiKey).toBe(apiKey);
          expect(input.parameters).toEqual({});
          expect(Object.keys(input.context).sort()).toEqual([
            "color",
            "fen",
            "legalMoves",
            "pgn",
            "turn",
          ]);
          return output("e2e4", apiKey);
        },
        () => {
          throw Object.assign(new Error(apiKey), {
            name: apiKey,
            code: apiKey,
            request: { apiKey },
          });
        },
      ],
    });
    const api = await harness.createApi({
      sandboxEnabled: false,
      aiAdapters: { openai: adapter },
      logger: {
        ...createLoggerOptions("info"),
        stream: {
          write: (chunk: string) => {
            logs.push(chunk);
          },
        },
      },
    });
    const guest = await harness.guest(api);
    const discovery = await post(api, guest, "/providers/models", { provider: "openai", apiKey });
    expect(discovery.json()).toEqual(catalog());
    expect(discovery.headers["cache-control"]).toBe("no-store");
    const details = await create(api, guest);
    expect(adapter.discoveryCalls).toBe(1);
    expect(details.configuration).toEqual(configuration);
    const command = turnCommand(details.snapshot);
    const moved = await post(api, guest, `/games/${command.gameId}/ai-turn`, {
      ...command,
      apiKey,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const snapshot = gameSnapshotSchema.parse(moved.json());
    expect(snapshot.moves).toHaveLength(1);
    const duplicate = await post(api, guest, `/games/${command.gameId}/ai-turn`, {
      ...command,
      apiKey,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: snapshot });
    expect(adapter.discoveryCalls).toBe(2);
    expect(adapter.moveCalls).toBe(1);
    const failed = await post(api, guest, `/games/${command.gameId}/ai-turn`, {
      ...turnCommand(snapshot),
      apiKey,
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()).toMatchObject({ state: "paused", version: 2, terminationReason: null });
    const invocations = gameInvocationsSchema.parse(
      (await get(api, guest, `/games/${command.gameId}/invocations`)).json(),
    );
    expect(invocations.turns[0]?.attempts[0]).toMatchObject({
      effectiveParameters: {},
      outcome: "accepted",
      commentary: null,
    });
    expect(invocations.turns[1]?.attempts[0]).toMatchObject({
      outcome: "provider_error",
      error: { code: "provider_unavailable", reason: "upstream" },
    });
    expect(invocations.turns[1]?.invalidOutputCount).toBe(0);
    const restored = await get(api, guest, `/games/${command.gameId}/details`);
    expect(restored.json()).toMatchObject({ configuration, snapshot: { state: "paused" } });
    const unfinished = await get(api, guest, "/games/unfinished");
    expect(unfinished.json()).toEqual({ game: restored.json<unknown>() });
    const turns = await api.database.db
      .select()
      .from(aiTurns)
      .where(eq(aiTurns.gameId, command.gameId));
    const records = await Promise.all([
      api.database.db.select().from(games).where(eq(games.id, command.gameId)),
      api.database.db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, command.gameId)),
      api.database.db.select().from(moves).where(eq(moves.gameId, command.gameId)),
      api.database.db.select().from(gameCommands).where(eq(gameCommands.gameId, command.gameId)),
      api.database.db
        .select()
        .from(aiTurnReservations)
        .where(eq(aiTurnReservations.gameId, command.gameId)),
      api.database.db
        .select()
        .from(modelInvocations)
        .where(
          inArray(
            modelInvocations.turnId,
            turns.map((turn) => turn.id),
          ),
        ),
    ]);
    for (const text of [
      JSON.stringify(records),
      JSON.stringify(turns),
      JSON.stringify(invocations),
      logs.join(""),
      discovery.body,
      moved.body,
      duplicate.body,
      failed.body,
      restored.body,
      unfinished.body,
      JSON.stringify(adapter),
    ]) {
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain(guest.token);
    }
  });

  it("rejects missing identities, cross-origin requests, credentials in configuration, and untrusted command context before upstream calls", async () => {
    const logs: string[] = [];
    const adapter = createScriptedAdapter({ provider: "openai" });
    const api = await harness.createApi({
      aiAdapters: { openai: adapter },
      logger: {
        ...createLoggerOptions("info"),
        stream: {
          write: (chunk: string) => {
            logs.push(chunk);
          },
        },
      },
    });
    const guest = await harness.guest(api);
    const stranger = await harness.guest(api);
    const { snapshot } = await create(api, guest);
    const command = turnCommand(snapshot);
    const turnUrl = `/games/${snapshot.gameId}/ai-turn`;
    const cases = [
      {
        url: "/providers/models",
        payload: { provider: "openai", apiKey },
        cookie: undefined,
        origin: WEB_ORIGIN,
        status: 401,
      },
      { url: "/games", payload: configuration, cookie: undefined, origin: WEB_ORIGIN, status: 401 },
      {
        url: turnUrl,
        payload: { ...command, apiKey },
        cookie: undefined,
        origin: WEB_ORIGIN,
        status: 401,
      },
      {
        url: turnUrl,
        payload: { ...command, apiKey },
        cookie: stranger.cookie,
        origin: WEB_ORIGIN,
        status: 404,
      },
      {
        url: "/providers/models",
        payload: { provider: "openai", apiKey },
        cookie: guest.cookie,
        origin: "https://other.test",
        status: 403,
      },
      {
        url: turnUrl,
        payload: { ...command, apiKey },
        cookie: guest.cookie,
        origin: WEB_ORIGIN + "/",
        status: 403,
      },
      {
        url: "/games",
        payload: { ...configuration, apiKey },
        cookie: guest.cookie,
        origin: WEB_ORIGIN,
        status: 400,
      },
      {
        url: turnUrl,
        payload: { ...command, apiKey, fen: apiKey },
        cookie: guest.cookie,
        origin: WEB_ORIGIN,
        status: 400,
      },
      {
        url: turnUrl,
        payload: { ...command, apiKey, gameId: randomUUID() },
        cookie: guest.cookie,
        origin: WEB_ORIGIN,
        status: 400,
      },
      {
        url: "/providers/models?apiKey=" + apiKey,
        payload: { provider: "openai", apiKey },
        cookie: guest.cookie,
        origin: WEB_ORIGIN,
        status: 400,
      },
      {
        url: turnUrl,
        payload: { ...command, apiKey: "" },
        cookie: guest.cookie,
        origin: WEB_ORIGIN,
        status: 400,
      },
      { url: turnUrl, payload: command, cookie: guest.cookie, origin: WEB_ORIGIN, status: 400 },
    ];
    for (const test of cases) {
      const response = await api.app.inject({
        method: "POST",
        url: test.url,
        payload: test.payload,
        headers: { origin: test.origin, ...(test.cookie ? { cookie: test.cookie } : {}) },
      });
      expect(response.statusCode, response.body).toBe(test.status);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(apiKey);
      if (!test.cookie) expect(response.headers["set-cookie"]).toBeUndefined();
    }
    for (const suffix of ["", "/details", "/invocations", "/replay", "/pgn"]) {
      expect((await get(api, stranger, `/games/${snapshot.gameId}${suffix}`)).statusCode).toBe(404);
    }
    expect(adapter.discoveryCalls).toBe(0);
    expect(adapter.moveCalls).toBe(0);
    expect(logs.join("")).not.toContain(apiKey);
  });

  it("does not share discovery between credentials, seats, or sessions", async () => {
    const keys = ["account-one-key", "account-two-key", "replacement-key"];
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: keys.map((key, i) => (input) => {
        expect(input.apiKey).toBe(key);
        return { ok: true, models: [{ ...turnCatalog("openai")[0]!, id: `account-model-${i}` }] };
      }),
    });
    const api = await harness.createApi({ aiAdapters: { openai: adapter } });
    const first = await harness.guest(api);
    const second = await harness.guest(api);
    for (const [i, key] of keys.entries()) {
      const response = await post(api, i === 1 ? second : first, "/providers/models", {
        provider: "openai",
        apiKey: key,
      });
      expect(response.json()).toMatchObject({ models: [{ id: `account-model-${i}` }] });
    }
    expect(adapter.discoveryCalls).toBe(3);
  });

  it.each([
    { ok: false, error: { code: "provider_auth" } },
    { ok: false, error: { code: "provider_quota" } },
    { ok: false, error: { code: "provider_timeout" } },
    { ok: false, error: { code: "provider_unavailable", reason: "network" } },
    { ok: true, models: [] },
    {
      ok: true,
      models: [
        {
          ...turnCatalog("openai")[0]!,
          capabilities: {
            ...turnCatalog("openai")[0]!.capabilities,
            moveGeneration: "unsupported",
          },
        },
      ],
    },
  ] satisfies ModelDiscoveryResult[])(
    "pauses safely when turn discovery cannot supply a callable model",
    async (discovery) => {
      const adapter = createScriptedAdapter({ provider: "openai", models: [discovery] });
      const api = await harness.createApi({ aiAdapters: { openai: adapter } });
      const guest = await harness.guest(api);
      const { snapshot } = await create(api, guest);
      const response = await post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
        ...turnCommand(snapshot),
        apiKey,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        state: "paused",
        moves: [],
        terminationReason: null,
      });
      const attempts = gameInvocationsSchema.parse(
        (await get(api, guest, `/games/${snapshot.gameId}/invocations`)).json(),
      );
      expect(attempts.turns[0]).toMatchObject({
        invalidOutputCount: 0,
        attempts: [{ outcome: "provider_error", effectiveParameters: {} }],
      });
      expect(adapter.moveCalls).toBe(0);
    },
  );

  it("allows unknown generation capabilities without speculative parameters", async () => {
    const model = turnCatalog("openai")[0]!;
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [
        {
          ok: true,
          models: [
            { ...model, capabilities: { ...model.capabilities, moveGeneration: "unknown" } },
          ],
        },
      ],
      moves: [
        (input) => {
          expect(input.parameters).toEqual({});
          return output("e2e4");
        },
      ],
    });
    const api = await harness.createApi({ aiAdapters: { openai: adapter } });
    const guest = await harness.guest(api);
    const { snapshot } = await create(api, guest);
    expect(
      (
        await post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
          ...turnCommand(snapshot),
          apiKey,
        })
      ).statusCode,
    ).toBe(200);
    expect(adapter.moveCalls).toBe(1);
  });

  it("pauses and rejects an out-of-range setting before inference without consuming an invalid-output attempt", async () => {
    const adapter = createScriptedAdapter({ provider: "openai", models: [catalog()] });
    const api = await harness.createApi({ aiAdapters: { openai: adapter } });
    const guest = await harness.guest(api);
    const { snapshot } = await create(api, guest, {
      mode: "ai_vs_human",
      seats: {
        white: { ...aiMatch.seats.white, parameters: { temperature: 3 } },
        black: { type: "human" },
      },
    });
    const command = turnCommand(snapshot);
    const response = await post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
      ...command,
      apiKey,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "AI_PARAMETERS_INVALID" });
    expect((await get(api, guest, `/games/${snapshot.gameId}`)).json()).toMatchObject({
      state: "paused",
      version: 1,
    });
    expect(
      gameInvocationsSchema.parse(
        (await get(api, guest, `/games/${snapshot.gameId}/invocations`)).json(),
      ).turns[0],
    ).toMatchObject({ invalidOutputCount: 0, attempts: [] });
    expect(
      (await post(api, guest, `/games/${snapshot.gameId}/ai-turn`, { ...command, apiKey })).json(),
    ).toMatchObject({ code: "GAME_CONFLICT" });
    expect(adapter.moveCalls).toBe(0);
  });

  it("fences duplicate discovery across API instances and rejects inference after Stop during discovery", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ModelDiscoveryResult>();
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [
        () => {
          entered.resolve();
          return release.promise;
        },
      ],
    });
    const other = createScriptedAdapter({ provider: "openai" });
    const api = await harness.createApi({ aiAdapters: { openai: adapter } });
    const second = await harness.createApi({ aiAdapters: { openai: other } });
    const guest = await harness.guest(api);
    const { snapshot } = await create(api, guest);
    const command = turnCommand(snapshot);
    const pending = post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
      ...command,
      apiKey,
    }).then((response) => response);
    await entered.promise;
    expect(
      (
        await post(second, guest, `/games/${snapshot.gameId}/ai-turn`, { ...command, apiKey })
      ).json(),
    ).toMatchObject({ code: "AI_TURN_IN_PROGRESS" });
    expect(other.discoveryCalls).toBe(0);
    const stopped = await post(
      second,
      guest,
      `/games/${snapshot.gameId}/lifecycle`,
      control(snapshot, "abort"),
    );
    expect(stopped.statusCode).toBe(200);
    release.resolve(catalog());
    expect((await pending).json()).toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: { state: "aborted" },
    });
    expect(adapter.moveCalls).toBe(0);
  });

  it("preserves Sandbox control with separate unfinished slots and discovery for ordinary games", async () => {
    const api = await harness.createApi();
    const guest = await harness.guest(api);
    const sandbox = await createSandbox(api, guest);
    expect((await get(api, guest, "/games/unfinished")).json()).toEqual({ game: null });
    expect(
      (
        await post(api, guest, `/games/${sandbox.gameId}/ai-turn`, {
          ...turnCommand(sandbox),
          apiKey,
        })
      ).statusCode,
    ).toBe(403);
    const game = await create(api, guest, {
      mode: "ai_vs_human",
      seats: { white: { type: "human" }, black: aiMatch.seats.black },
    });
    expect((await get(api, guest, "/sandbox/games/unfinished")).json()).toEqual({
      snapshot: sandbox,
    });
    expect((await get(api, guest, "/games/unfinished")).json()).toEqual({ game });
    const conflict = await post(api, guest, "/games", configuration);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: game.snapshot,
    });
    const moved = await post(api, guest, `/games/${game.snapshot.gameId}/moves`, {
      ...command(game.snapshot, "e2e4"),
    });
    expect(moved.statusCode).toBe(200);
    const next = gameSnapshotSchema.parse(moved.json());
    expect(
      (
        await post(api, guest, `/games/${next.gameId}/moves`, {
          ...command(next, "e7e5"),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(api, guest, `/games/${next.gameId}/ai-turn`, { ...turnCommand(next), apiKey })
      ).json(),
    ).toMatchObject({ code: "AI_ADAPTER_UNAVAILABLE" });
    const sandboxConflict = await post(api, guest, "/sandbox/games", {});
    expect(sandboxConflict.statusCode).toBe(409);
    expect(sandboxConflict.json()).toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: sandbox,
    });
    expect((await get(api, guest, `/games/${sandbox.gameId}`)).json()).toEqual(sandbox);
  });
});
