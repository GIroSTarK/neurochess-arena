import {
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  aiCommand,
  controlled,
  createAi,
  credential,
  lifecycle,
  mock,
  runtime,
  turn,
  white,
} from "./ai-helpers.js";
import { ApiHarness, command, FOOLS_MATE, snapshot, submit } from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

describe("private AI invocation telemetry", () => {
  it.each(["ai_vs_ai", "ai_vs_human"] as const)(
    "associates accepted commentary and measurements with exact moves through %s replay",
    async (mode) => {
      const commentary = '<img src=x onerror="alert(1)"> viewer text';
      const steps = [
        { output: "malformed", telemetry: { latencyMs: 11, usage: null } },
        {
          output: { move: FOOLS_MATE[0], commentary },
          telemetry: {
            latencyMs: 22,
            usage: { inputTokens: 0, outputTokens: 7, totalTokens: null },
            providerRequestId: "private-request-id",
          },
        },
        ...(mode === "ai_vs_ai" ? [{ output: { move: FOOLS_MATE[1] } }] : []),
        {
          output: { move: FOOLS_MATE[2] },
          telemetry: {
            latencyMs: 44,
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          },
        },
        ...(mode === "ai_vs_ai" ? [{ output: { move: FOOLS_MATE[3] } }] : []),
      ];
      const provider = mock(steps);
      const api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      let current = await createAi(
        api,
        guest,
        mode === "ai_vs_human" ? { mode, humanColor: "black", ai: white } : undefined,
      );
      // Lifecycle revisions must never be mistaken for plies.
      current = gameSnapshotSchema.parse((await lifecycle(api, guest, current, "pause")).json());
      current = gameSnapshotSchema.parse((await lifecycle(api, guest, current, "resume")).json());
      for (const [index, move] of FOOLS_MATE.entries()) {
        const response =
          mode === "ai_vs_human" && index % 2 === 1
            ? await submit(api, guest, command(current, move))
            : await turn(api, guest, aiCommand(current));
        expect(response.statusCode, response.body).toBe(200);
        current = gameSnapshotSchema.parse(response.json());
        expect(current).toEqual(await snapshot(api, guest, current.gameId));
      }
      expect(current.invocations?.slice(0, 2)).toEqual([
        {
          ply: 1,
          color: "white",
          attempt: 1,
          status: "model_invalid",
          accepted: false,
          commentary: null,
          error: { kind: "model_invalid", reason: "malformed_output" },
          latencyMs: 11,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        },
        {
          ply: 1,
          color: "white",
          attempt: 2,
          status: "succeeded",
          accepted: true,
          commentary,
          error: null,
          latencyMs: 22,
          usage: { inputTokens: 0, outputTokens: 7, totalTokens: null },
        },
      ]);
      expect(current.invocations?.find((entry) => entry.ply === 3)).toMatchObject({
        accepted: true,
        attempt: 1,
        commentary: null,
        latencyMs: 44,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      });
      if (mode === "ai_vs_human") {
        expect(current.invocations?.map((entry) => entry.ply)).toEqual([1, 1, 3]);
      }
      const restarted = await harness.createApi({ sandboxEnabled: false });
      const read = (suffix: string, cookie = guest.cookie) =>
        restarted.app.inject({
          method: "GET",
          url: `/games/${current.gameId}${suffix ? `/${suffix}` : ""}`,
          headers: { cookie },
        });
      const replay = await read("replay");
      expect(replay.statusCode).toBe(200);
      expect(gameReplayResponseSchema.parse(replay.json()).snapshot).toEqual(current);
      expect(gamePgnResponseSchema.parse((await read("pgn")).json()).pgn).toBe(current.pgn);
      expect(current.pgn).not.toContain(commentary);
      expect(current.pgn).not.toContain("fixture-model");
      for (const forbidden of [
        credential.apiKey,
        "private-request-id",
        "reservationId",
        "executorId",
        "providerRequestId",
        "ownerGuestSessionId",
      ]) {
        expect(replay.body).not.toContain(forbidden);
      }
      expect(provider.requests.every((request) => !request.context.pgn.includes(commentary))).toBe(
        true,
      );
      const stranger = await harness.guest(restarted);
      for (const suffix of ["replay", "pgn", ""]) {
        const response = await read(suffix, stranger.cookie);
        expect([403, 404]).toContain(response.statusCode);
        expect(response.body).not.toContain(commentary);
      }
    },
  );

  it("keeps invalid attempts across a provider pause and manual retry ending in technical loss", async () => {
    const api = await harness.createApi({
      ai: runtime(
        mock([
          { output: { move: "e7e5", commentary: "must not be accepted" } },
          { error: { kind: "provider_quota" }, telemetry: { latencyMs: 19, usage: null } },
          { output: "bad" },
          { output: "bad again" },
        ]),
      ),
    });
    const guest = await harness.guest(api);
    let current = await createAi(api, guest);
    current = gameSnapshotSchema.parse((await turn(api, guest, aiCommand(current))).json());
    expect(current.state).toBe("paused");
    expect(current.invocations?.map((entry) => entry.error)).toEqual([
      { kind: "model_invalid", reason: "illegal_move" },
      { kind: "provider_quota" },
    ]);
    current = gameSnapshotSchema.parse((await turn(api, guest, aiCommand(current))).json());
    expect(current.terminationReason).toBe("model_technical_loss");
    expect(current.moves).toEqual([]);
    expect(
      current.invocations?.map(({ ply, attempt, accepted, commentary }) => ({
        ply,
        attempt,
        accepted,
        commentary,
      })),
    ).toEqual(
      [1, 2, 3, 4].map((attempt) => ({ ply: 1, attempt, accepted: false, commentary: null })),
    );
    expect(current).toEqual(await snapshot(api, guest, current.gameId));
  });

  it("exposes pending and interrupted calls with unknown telemetry without accepting a late move", async () => {
    const provider = controlled([{ output: { move: "e2e4", commentary: "late" } }]);
    const api = await harness.createApi({ ai: runtime(provider.adapter) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const pending = turn(api, guest, aiCommand(initial));
    const response = pending.then((value) => value);
    await provider.entered;
    try {
      const during = await snapshot(api, guest, initial.gameId);
      expect(during.version).toBe(initial.version);
      expect(during.invocations?.[0]).toMatchObject({
        status: "pending",
        accepted: false,
        commentary: null,
        latencyMs: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      });
      const stopped = gameSnapshotSchema.parse(
        (await lifecycle(api, guest, initial, "abort")).json(),
      );
      expect(stopped.invocations?.[0]).toMatchObject({
        status: "abandoned",
        accepted: false,
        commentary: null,
        latencyMs: null,
      });
      expect(stopped.moves).toEqual([]);
    } finally {
      provider.release();
      await response;
    }
  });
});
