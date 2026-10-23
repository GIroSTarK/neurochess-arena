import { randomUUID } from "node:crypto";

import {
  type AiGameConfiguration,
  type AiProvider,
  type AiSeat,
  type ChessColor,
  gameDetailsSchema,
  gameInvocationsSchema,
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { AiAdapters } from "../src/games/ai-turn.js";
import { AI_MOVE_INSTRUCTIONS } from "../src/providers/adapter.js";

import { turnCommand } from "./ai-turn-helpers.js";
import {
  ApiHarness,
  claimController,
  FOOLS_MATE,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "./helpers.js";
import { type AdapterContractFixture, PROVIDER_KEY } from "./providers/adapter-contract.js";
import { anthropicFixture } from "./providers/anthropic-fixtures.js";
import { googleFixture } from "./providers/google-fixtures.js";
import { type HttpStep, mockHttp } from "./providers/mock-http.js";
import { openAiFixture } from "./providers/openai-fixtures.js";
import { openRouterFixture } from "./providers/openrouter-fixtures.js";

const fixtures: Record<AiProvider, AdapterContractFixture> = {
  openai: openAiFixture,
  anthropic: anthropicFixture,
  google: googleFixture,
  openrouter: openRouterFixture,
};
const providers = Object.keys(fixtures) as AiProvider[];
const harness = new ApiHarness();
afterEach(() => harness.dispose());

function seat(provider: AiProvider, color: ChessColor): AiSeat {
  const fixture = fixtures[provider];
  return {
    type: "ai",
    provider,
    modelId: fixture.modelId,
    parameters: { ...fixture.parameters, maxOutputTokens: color === "white" ? 128 : 256 },
  };
}
function post(api: TestApi, guest: TestGuest, url: string, payload: object) {
  return api.app.inject({
    method: "POST",
    url,
    payload,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}
function get(api: TestApi, guest: TestGuest, url: string) {
  return api.app.inject({ method: "GET", url, headers: { cookie: guest.cookie } });
}
async function createControlledGame(
  api: TestApi,
  guest: TestGuest,
  configuration: AiGameConfiguration,
) {
  const response = await post(api, guest, "/games", configuration);
  expect(response.statusCode, response.body).toBe(201);
  const details = gameDetailsSchema.parse(response.json());
  expect(details.configuration).toEqual(configuration);
  await claimController(api, guest, details.snapshot, details.snapshot.gameId);
  return details.snapshot;
}
async function terminalReplay(api: TestApi, owner: TestGuest, snapshot: GameSnapshot) {
  const base = `/games/${snapshot.gameId}`;
  const replay = await get(api, owner, base + "/replay");
  const pgn = await get(api, owner, base + "/pgn");
  expect(replay.statusCode).toBe(200);
  expect(pgn.statusCode).toBe(200);
  expect(gameReplayResponseSchema.parse(replay.json()).snapshot).toEqual(snapshot);
  expect(gamePgnResponseSchema.parse(pgn.json()).pgn).toBe(snapshot.pgn);
  expect(snapshot.pgn).not.toMatch(
    /Viewer note|commentary|openai|anthropic|google|openrouter|gpt-|claude|gemini/i,
  );
}

async function complete(configuration: AiGameConfiguration) {
  const adapters: { -readonly [K in keyof AiAdapters]: AiAdapters[K] } = {};
  const transports = new Map<AiProvider, ReturnType<typeof mockHttp>>();
  const sent = new Map<number, Parameters<AdapterContractFixture["readMove"]>[0]>();
  for (const provider of providers) {
    const fixture = fixtures[provider];
    const steps: HttpStep[] = [];
    FOOLS_MATE.forEach((move, index) => {
      const color = index % 2 ? "black" : "white";
      const configured = configuration.seats[color];
      if (configured.type !== "ai" || configured.provider !== provider) return;
      steps.push(...fixture.catalog([configured.modelId]), (request) => {
        sent.set(index + 1, request);
        return fixture.completion(
          JSON.stringify({
            move,
            ...(index % 2 ? {} : { commentary: `Viewer note ${index + 1}` }),
          }),
          index === 2 ? null : fixture.reportedUsage,
        );
      });
    });
    const http = mockHttp(steps);
    transports.set(provider, http);
    adapters[provider] = fixture.createAdapter(http.transport);
  }
  const api = await harness.createApi({ aiAdapters: adapters, sandboxEnabled: false });
  const guest = await harness.guest(api);
  let snapshot = await createControlledGame(api, guest, configuration);
  const initial = snapshot;
  const blocked = await post(api, guest, "/games", configuration);
  expect(blocked.statusCode).toBe(409);
  for (const [index, move] of FOOLS_MATE.entries()) {
    const configured = configuration.seats[snapshot.turn];
    const before = snapshot;
    const response =
      configured.type === "human"
        ? await post(api, guest, `/games/${snapshot.gameId}/moves`, {
            gameId: snapshot.gameId,
            commandId: randomUUID(),
            expectedVersion: snapshot.version,
            move,
          })
        : await post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
            ...turnCommand(snapshot, snapshot.gameId),
            apiKey: PROVIDER_KEY,
          });
    expect(response.statusCode, response.body).toBe(200);
    snapshot = gameSnapshotSchema.parse(response.json());
    expect(snapshot.moves.map(({ uci }) => uci)).toEqual(FOOLS_MATE.slice(0, index + 1));
    if (configured.type === "ai") {
      const input = await fixtures[configured.provider].readMove(sent.get(index + 1)!);
      expect(input).toEqual({
        instructions: AI_MOVE_INSTRUCTIONS,
        modelId: configured.modelId,
        parameters: configured.parameters,
        context: {
          fen: before.fen,
          pgn: before.pgn,
          color: before.turn,
          turn: before.turn,
          legalMoves: before.legalMoves,
        },
      });
      expect(JSON.stringify(input.context)).not.toMatch(
        /Viewer note|commentary|stockfish|evaluation|gpt-|claude|gemini/i,
      );
    }
  }
  expect(snapshot).toMatchObject({
    state: "completed",
    result: "0-1",
    terminationReason: "checkmate",
  });
  const response = await get(api, guest, `/games/${snapshot.gameId}/invocations`);
  const records = gameInvocationsSchema.parse(response.json());
  const aiPlies = FOOLS_MATE.map((_, index) => index + 1).filter(
    (ply) => configuration.seats[ply % 2 ? "white" : "black"].type === "ai",
  );
  expect(records.turns.map((turn) => turn.acceptedMovePly)).toEqual(aiPlies);
  for (const turn of records.turns) {
    const configured = configuration.seats[turn.color] as AiSeat;
    expect(turn.attempts).toHaveLength(1);
    expect(turn.attempts[0]).toMatchObject({
      outcome: "accepted",
      effectiveParameters: configured.parameters,
      provider: configured.provider,
      modelId: configured.modelId,
      commentary: turn.ply % 2 ? `Viewer note ${turn.ply}` : null,
      usage: turn.ply === 3 ? null : fixtures[configured.provider].reportedUsage,
    });
    expect(turn.attempts[0]?.durationMs).toBeTypeOf("number");
  }
  expect(JSON.stringify({ initial, snapshot, records })).not.toContain(PROVIDER_KEY);
  for (const [provider, http] of transports) {
    const count = aiPlies.filter(
      (ply) => (configuration.seats[ply % 2 ? "white" : "black"] as AiSeat).provider === provider,
    ).length;
    expect(http.transport).toHaveBeenCalledTimes(count * 2);
  }
  await terminalReplay(api, guest, snapshot);
}

describe("Phase 2 deterministic provider acceptance matrix through real adapters, HTTP and PostgreSQL", () => {
  it.each(providers.flatMap((white) => providers.map((black) => ({ white, black }))))(
    "$white White versus $black Black completes with matching private replay and PGN",
    async ({ white, black }) =>
      complete({
        mode: "ai_vs_ai",
        seats: { white: seat(white, "white"), black: seat(black, "black") },
      }),
  );
  it.each(
    providers.flatMap((provider) =>
      (["white", "black"] as const).map((human) => ({ provider, human })),
    ),
  )(
    "$provider versus human $human completes with matching private replay and PGN",
    async ({ provider, human }) =>
      complete({
        mode: "ai_vs_human",
        seats:
          human === "white"
            ? { white: { type: "human" }, black: seat(provider, "black") }
            : { white: seat(provider, "white"), black: { type: "human" } },
      }),
  );
});
