import { randomUUID } from "node:crypto";

import { type ChessSnapshot, createGame, type DomainResult } from "@neurochess/chess";
import type { AiReservationOwner, GamePositionUpdate } from "@neurochess/database";
import { afterEach, describe, expect, it } from "vitest";

import { buildModelContext } from "../src/providers/context.js";
import { createScriptedMockProvider } from "../src/providers/mock.js";

import { ApiHarness, snapshot, WEB_ORIGIN } from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

function unwrap<T>(result: DomainResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function positionOf(snapshot: ChessSnapshot, version: number): GamePositionUpdate {
  return {
    state: snapshot.state,
    result: snapshot.result,
    terminationReason: snapshot.terminationReason,
    fen: snapshot.fen,
    pgn: snapshot.pgn,
    version,
  };
}

async function fixture() {
  const api = await harness.createApi({ sandboxEnabled: false });
  const guest = await harness.guest(api);
  const gameId = randomUUID();
  const game = createGame();
  const initial = unwrap(game.start());
  await api.repository.write(async (tx) => {
    await tx.lockGuest(guest.id);
    await tx.insertGame(
      { id: gameId, ownerGuestSessionId: guest.id, mode: "ai_vs_ai", ...positionOf(initial, 0) },
      [
        { gameId, color: "white", seatType: "ai", provider: "openai", modelId: "mock-model" },
        { gameId, color: "black", seatType: "ai", provider: "google", modelId: "other-mock-model" },
      ],
    );
  });
  const request = {
    gameId,
    ownerGuestSessionId: guest.id,
    expectedVersion: 0,
    commandId: randomUUID(),
    executorId: randomUUID(),
    color: initial.turn,
    leaseMs: 60_000,
  };
  const granted = await api.repository.write((tx) => tx.reserveAiTurn(request));
  if (granted.status !== "reserved") throw new Error("Reservation fixture failed");
  const owner: AiReservationOwner = {
    gameId,
    ownerGuestSessionId: guest.id,
    reservationId: granted.reservation.id,
    executorId: request.executorId,
  };
  const provider = createScriptedMockProvider({
    descriptor: { id: "openai", name: "Test provider" },
    models: [{ provider: "openai", id: "mock-model", name: "Test model", supportedParameters: {} }],
    moves: [{ output: { move: "e2e4", commentary: "Test commentary" } }],
  });
  return { api, guest, game, gameId, initial, request, owner, provider };
}

describe("AI persistence composes with existing authoritative private commands", () => {
  it("stores a mocked result outside provider I/O transactions and restores its accepted move through the real snapshot service", async () => {
    const { api, guest, game, gameId, request, owner, provider } = await fixture();
    const invocation = await api.repository.write((tx) => tx.beginAiInvocation(owner));
    const duplicate = await api.app.inject({
      method: "POST",
      url: `/games/${gameId}/lifecycle`,
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
      payload: { gameId, commandId: request.commandId, expectedVersion: 0, action: "pause" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: { version: 0, state: "active" },
    });
    const result = await provider.requestMove({
      apiKey: "placeholder-test-key",
      configuration: { provider: "openai", modelId: "mock-model", parameters: {} },
      context: buildModelContext(game, "white"),
    });
    if (!result.ok) throw new Error("Mock fixture failed");
    const accepted = unwrap(game.playMove(result.value.move));
    await api.repository.write(async (tx) => {
      await tx.recordAiInvocation(owner, invocation.id, result);
      await tx.commitAiTurn(owner, { position: positionOf(accepted, 1), move: accepted.moves[0]! });
    });
    const restored = await snapshot(api, guest, gameId);
    expect(restored).toMatchObject({ ...accepted, gameId, version: 1 });
    expect(restored.invocations?.[0]).toMatchObject({
      ply: 1,
      accepted: true,
      commentary: "Test commentary",
      latencyMs: 0,
    });
    expect(restored.pgn).not.toContain("Test commentary");
    const intruder = await harness.guest(api);
    const denied = await api.app.inject({
      method: "GET",
      url: `/games/${gameId}`,
      headers: { cookie: intruder.cookie },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).not.toHaveProperty("currentSnapshot");
    expect(provider.requests).toHaveLength(1);
    expect(
      JSON.stringify(await api.repository.read((reader) => reader.getModelInvocations(gameId))),
    ).not.toContain("placeholder-test-key");
  });

  it("lets the real pause command invalidate a reserved attempt before a late mocked response arrives", async () => {
    const { api, guest, game, gameId, initial, owner, provider } = await fixture();
    const invocation = await api.repository.write((tx) => tx.beginAiInvocation(owner));
    const pause = await api.app.inject({
      method: "POST",
      url: `/games/${gameId}/lifecycle`,
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
      payload: { gameId, commandId: randomUUID(), expectedVersion: 0, action: "pause" },
    });
    expect(pause.statusCode).toBe(200);
    const result = await provider.requestMove({
      apiKey: "placeholder-test-key",
      configuration: { provider: "openai", modelId: "mock-model", parameters: {} },
      context: buildModelContext(game, "white"),
    });
    await expect(
      api.repository.write((tx) => tx.recordAiInvocation(owner, invocation.id, result)),
    ).rejects.toMatchObject({ code: "RESERVATION_LOST" });
    expect(await snapshot(api, guest, gameId)).toMatchObject({
      state: "paused",
      version: 1,
      fen: initial.fen,
      pgn: initial.pgn,
      moves: [],
    });
    expect(
      (await api.repository.read((reader) => reader.getModelInvocations(gameId)))[0],
    ).toMatchObject({ status: "abandoned", move: null });
  });
});
