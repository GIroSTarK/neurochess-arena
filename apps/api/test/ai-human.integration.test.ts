import { randomUUID } from "node:crypto";

import {
  type AiGameConfiguration,
  gameDetailsSchema,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { output, turnCommand, whiteAi } from "./ai-turn-helpers.js";
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
function post(api: TestApi, guest: TestGuest, url: string, payload: object) {
  return api.app.inject({
    method: "POST",
    url,
    payload,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}

describe("AI versus human HTTP authority", () => {
  for (const sandboxEnabled of [false, true]) {
    it.each(["white", "black"] as const)(
      `assigns only human %s with Sandbox ${String(sandboxEnabled)}, deduplicates commands and completes through the shared engine`,
      async (human) => {
        const adapter = createScriptedAdapter({
          provider: "openai",
          models: [
            { ok: true, models: turnCatalog("openai") },
            { ok: true, models: turnCatalog("openai") },
          ],
          moves:
            human === "white" ? [output("e7e5"), output("d8h4")] : [output("f2f3"), output("g2g4")],
        });
        const api = await harness.createApi({ sandboxEnabled, aiAdapters: { openai: adapter } });
        const guest = await harness.guest(api);
        const stranger = await harness.guest(api);
        if (sandboxEnabled) {
          const sandbox = await createSandbox(api, guest);
          const stopped = await post(api, guest, `/games/${sandbox.gameId}/lifecycle`, {
            gameId: sandbox.gameId,
            expectedVersion: sandbox.version,
            commandId: randomUUID(),
            action: "abort",
          });
          expect(stopped.statusCode).toBe(200);
        }
        const configuration: AiGameConfiguration = {
          mode: "ai_vs_human",
          seats:
            human === "white"
              ? { white: { type: "human" }, black: whiteAi }
              : { white: whiteAi, black: { type: "human" } },
        };
        expect(
          (await post(api, guest, "/games", { ...configuration, isSandbox: true })).statusCode,
        ).toBe(400);
        const created = await post(api, guest, "/games", configuration);
        expect(created.statusCode).toBe(201);
        let { snapshot } = gameDetailsSchema.parse(created.json());
        await claimController(api, guest, snapshot, snapshot.gameId);
        const participants = await api.repository.read((reader) =>
          reader.getParticipants(snapshot.gameId),
        );
        expect(
          participants.filter((seat) => seat.guestSessionId === guest.id).map((seat) => seat.color),
        ).toEqual([human]);
        expect(
          (await api.repository.read((reader) => reader.getGame(snapshot.gameId)))?.isSandbox,
        ).toBe(false);
        const aiColor = human === "white" ? "black" : "white";
        const aiResign = await post(api, guest, `/games/${snapshot.gameId}/lifecycle`, {
          gameId: snapshot.gameId,
          expectedVersion: snapshot.version,
          commandId: randomUUID(),
          action: "resign",
          losingColor: aiColor,
        });
        expect(aiResign.statusCode).toBe(403);
        for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
          const path = `/games/${snapshot.gameId}`;
          if (snapshot.turn === human) {
            const move = command(snapshot, uci);
            expect((await post(api, stranger, path + "/moves", move)).statusCode).toBe(404);
            const calls = adapter.moveCalls;
            expect(
              (
                await post(api, guest, path + "/ai-turn", {
                  ...turnCommand(snapshot, snapshot.gameId),
                  apiKey: "human-test-key",
                })
              ).statusCode,
            ).toBe(403);
            expect(adapter.moveCalls).toBe(calls);
            const replies = await Promise.all([
              post(api, guest, path + "/moves", move),
              post(api, guest, path + "/moves", move),
            ]);
            expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
            snapshot = gameSnapshotSchema.parse(
              replies.find((reply) => reply.statusCode === 200)!.json(),
            );
          } else {
            expect(
              (await post(api, guest, path + "/moves", command(snapshot, uci))).statusCode,
            ).toBe(403);
            const result = await post(api, guest, path + "/ai-turn", {
              ...turnCommand(snapshot, snapshot.gameId),
              apiKey: "human-test-key",
            });
            expect(result.statusCode).toBe(200);
            snapshot = gameSnapshotSchema.parse(result.json());
          }
          expect(snapshot.moves.at(-1)?.uci).toBe(uci);
        }
        expect(snapshot).toMatchObject({
          state: "completed",
          result: "0-1",
          terminationReason: "checkmate",
          version: 4,
        });
        expect(adapter.moveCalls).toBe(2);
      },
    );
  }

  it.each(["white", "black"] as const)(
    "allows only human %s resignation while paused and off-turn",
    async (human) => {
      const api = await harness.createApi();
      const guest = await harness.guest(api);
      const configuration: AiGameConfiguration = {
        mode: "ai_vs_human",
        seats:
          human === "white"
            ? { white: { type: "human" }, black: whiteAi }
            : { white: whiteAi, black: { type: "human" } },
      };
      let { snapshot } = gameDetailsSchema.parse(
        (await post(api, guest, "/games", configuration)).json(),
      );
      if (human === "white") {
        snapshot = gameSnapshotSchema.parse(
          (
            await post(api, guest, `/games/${snapshot.gameId}/moves`, command(snapshot, "e2e4"))
          ).json(),
        );
      }
      const base = () => ({
        gameId: snapshot.gameId,
        expectedVersion: snapshot.version,
        commandId: randomUUID(),
      });
      snapshot = gameSnapshotSchema.parse(
        (
          await post(api, guest, `/games/${snapshot.gameId}/lifecycle`, {
            ...base(),
            action: "pause",
          })
        ).json(),
      );
      const path = `/games/${snapshot.gameId}/lifecycle`;
      expect(
        (
          await post(api, guest, path, {
            ...base(),
            action: "resign",
            losingColor: human === "white" ? "black" : "white",
          })
        ).statusCode,
      ).toBe(403);
      const resign = { ...base(), action: "resign", losingColor: human };
      const result = await post(api, guest, path, resign);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        state: "completed",
        terminationReason: "human_resignation",
        result: human === "white" ? "0-1" : "1-0",
      });
      expect((await post(api, guest, path, resign)).statusCode).toBe(409);
    },
  );
});
