import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import {
  aiTurnReservations,
  gameCommands,
  gameParticipants,
  games,
  moves,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  humanMatch,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import { ApiHarness } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

describe("AI reservation invalidation and crash recovery", () => {
  it.each(["pause", "abort", "resign"] as const)(
    "rejects late success after %s from an independent API and keeps the accepted lifecycle receipt",
    async (action) => {
      const api = await harness.createApi();
      const other = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const gate = gatedAdapter();
      const gamesService = service(api, { openai: gate.adapter });
      const { snapshot } = await gamesService.createAi(principal, humanMatch);
      const cmd = turnCommand(snapshot);
      const pending = gamesService.aiTurn(principal, cmd, access());
      await gate.entered;
      await expect(
        service(other).lifecycle(principal, { ...cmd, action: "pause" }),
      ).rejects.toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: snapshot });
      const lifecycle =
        action === "resign"
          ? { ...turnCommand(snapshot), action, losingColor: "black" as const }
          : control(snapshot, action);
      const accepted = await service(other).lifecycle(principal, lifecycle);
      expect(accepted.version).toBe(1);
      expect(accepted.moves).toHaveLength(0);
      const rejected = expect(pending).rejects.toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: accepted,
      });
      gate.resolve(output("e2e4"));
      await rejected;
      expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(accepted);
      expect(
        await api.database.db.$count(
          aiTurnReservations,
          eq(aiTurnReservations.gameId, snapshot.gameId),
        ),
      ).toBe(0);
      expect(
        await api.database.db
          .select()
          .from(gameCommands)
          .where(eq(gameCommands.gameId, snapshot.gameId)),
      ).toMatchObject([{ commandId: lifecycle.commandId, kind: action }]);
    },
  );

  it.each(["success", "failure"] as const)(
    "cannot let an old %s or its cleanup affect a new reservation after Pause/Resume",
    async (outcome) => {
      const api = await harness.createApi();
      const other = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const oldGate = gatedAdapter();
      const newGate = gatedAdapter();
      const oldService = service(api, { openai: oldGate.adapter });
      const newService = service(other, { openai: newGate.adapter });
      let { snapshot } = await oldService.createAi(principal, aiMatch);
      const oldCommand = turnCommand(snapshot);
      const oldPending = oldService.aiTurn(principal, oldCommand, access());
      await oldGate.entered;
      snapshot = await newService.lifecycle(principal, control(snapshot, "pause"));
      snapshot = await newService.lifecycle(principal, control(snapshot, "resume"));
      const newCommand = turnCommand(snapshot);
      const newPending = newService.aiTurn(principal, newCommand, access());
      await newGate.entered;
      const rejected = expect(oldPending).rejects.toMatchObject({
        code: "GAME_CONFLICT",
      });
      if (outcome === "success") oldGate.resolve(output("e2e4"));
      else oldGate.reject(new Error("secret-upstream-sentinel"));
      await rejected;
      expect(
        await api.database.db
          .select()
          .from(aiTurnReservations)
          .where(eq(aiTurnReservations.gameId, snapshot.gameId)),
      ).toMatchObject([
        { commandId: newCommand.commandId, state: "in_flight", expectedVersion: 2 },
      ]);
      newGate.resolve(output("d2d4"));
      const final = await newPending;
      expect(final).toMatchObject({ version: 3, moves: [{ uci: "d2d4" }] });
      expect(await newService.snapshot(principal, snapshot.gameId)).toEqual(final);
    },
  );

  it.each([false, true])(
    "rejects a blocked reservation's result even at an unchanged revision (step: %s)",
    async (step) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const gate = gatedAdapter();
      const gamesService = service(api, { openai: gate.adapter });
      let { snapshot } = await gamesService.createAi(principal, aiMatch);
      if (step) snapshot = await gamesService.lifecycle(principal, control(snapshot, "pause"));
      const pending = gamesService.aiTurn(principal, { ...turnCommand(snapshot), step }, access());
      await gate.entered;
      await api.database.db
        .update(aiTurnReservations)
        .set({ state: "blocked" })
        .where(eq(aiTurnReservations.gameId, snapshot.gameId));
      const rejected = expect(pending).rejects.toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: snapshot,
      });
      gate.resolve(output("e2e4"));
      await rejected;
      expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
    },
  );

  it("cancels before dispatch without a reservation, and interrupts an in-flight adapter without leaking the abort reason or accepting its late result", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const controller = new AbortController();
    const gate = gatedAdapter("openai", (input) => expect(input.signal).toBe(controller.signal));
    const gamesService = service(api, { openai: gate.adapter });
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    const cmd = turnCommand(snapshot);
    await expect(
      gamesService.aiTurn(principal, cmd, access(AbortSignal.abort("abort-secret-sentinel"))),
    ).rejects.toMatchObject({ code: "AI_TURN_CANCELLED", message: "AI_TURN_CANCELLED" });
    expect(gate.adapter.moveCalls).toBe(0);
    expect(
      await api.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
    const pending = gamesService.aiTurn(principal, cmd, access(controller.signal));
    await gate.entered;
    controller.abort("abort-secret-sentinel");
    const paused = await pending;
    expect(paused).toMatchObject({ state: "paused", version: 1, moves: [] });
    gate.resolve(output("e2e4"));
    await expect(gamesService.aiTurn(principal, cmd, access())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: paused,
    });
    expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(paused);
    expect(await gamesService.invocations(principal, snapshot.gameId)).toMatchObject({
      turns: [
        {
          invalidOutputCount: 0,
          attempts: [
            {
              outcome: "provider_error",
              error: { code: "provider_unavailable", reason: "cancelled" },
            },
          ],
        },
      ],
    });
    expect(gate.adapter.moveCalls).toBe(1);
  });

  it.each(["exception", "normalized failure"] as const)(
    "pauses a failed execution after %s and drops provider data",
    async (failure) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const adapter = createScriptedAdapter({
        provider: "openai",
        moves: [
          () => {
            if (failure === "exception") {
              throw new Error("provider-secret-sentinel", { cause: { apiKey: access().apiKey } });
            }
            return {
              ok: false,
              error: { code: "provider_auth" },
              durationMs: 1,
              usage: null,
              providerRequestId: null,
            };
          },
        ],
      });
      const gamesService = service(api, { openai: adapter });
      const { snapshot } = await gamesService.createAi(principal, aiMatch);
      const cmd = turnCommand(snapshot);
      const paused = await gamesService.aiTurn(principal, cmd, access());
      expect(paused).toMatchObject({ state: "paused", version: 1, moves: [] });
      await expect(
        gamesService.aiTurn(principal, turnCommand(snapshot), access()),
      ).rejects.toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: paused });
      expect(adapter.moveCalls).toBe(1);
      expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(paused);
      const persisted = await Promise.all([
        api.database.db.select().from(games).where(eq(games.id, snapshot.gameId)),
        api.database.db
          .select()
          .from(gameParticipants)
          .where(eq(gameParticipants.gameId, snapshot.gameId)),
        api.database.db.select().from(moves).where(eq(moves.gameId, snapshot.gameId)),
        api.database.db.select().from(gameCommands).where(eq(gameCommands.gameId, snapshot.gameId)),
        api.database.db
          .select()
          .from(aiTurnReservations)
          .where(eq(aiTurnReservations.gameId, snapshot.gameId)),
        api.repository.read((reader) => reader.getModelInvocations(snapshot.gameId)),
        gamesService.invocations(principal, snapshot.gameId),
      ]);
      expect(JSON.stringify(persisted)).not.toContain("sentinel");
      expect(JSON.stringify(adapter)).not.toContain("sentinel");
    },
  );

  it("rolls back a failed reservation insert without dispatching and permits a fresh execution", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const adapter = createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] });
    const failing = service(
      api,
      { openai: adapter },
      {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              async reserveAiTurn(reservation) {
                await tx.reserveAiTurn(reservation);
                throw new Error("Injected reservation failure");
              },
            }),
          ),
      },
    );
    const { snapshot } = await failing.createAi(principal, aiMatch);
    const cmd = turnCommand(snapshot);
    await expect(failing.aiTurn(principal, cmd, access())).rejects.toThrow(
      "Injected reservation failure",
    );
    expect(adapter.moveCalls).toBe(0);
    expect(
      await api.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
    expect(await service(api, { openai: adapter }).aiTurn(principal, cmd, access())).toMatchObject({
      version: 1,
    });
  });

  it.each(["receipt", "move", "position", "execution invalidation"] as const)(
    "rolls back a commit failure after an actual %s write and retains a recovery block",
    async (stage) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const adapter = createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] });
      function failAt(written: typeof stage) {
        if (stage === written) throw new Error("Injected commit failure");
      }
      const failing = service(
        api,
        { openai: adapter },
        {
          ...api.repository,
          write: (action) =>
            api.repository.write((tx) =>
              action({
                ...tx,
                async appendCommand(receipt) {
                  await tx.appendCommand(receipt);
                  failAt("receipt");
                },
                async appendMove(move) {
                  await tx.appendMove(move);
                  failAt("move");
                },
                async updatePosition(...args) {
                  const result = await tx.updatePosition(...args);
                  failAt("position");
                  return result;
                },
                async invalidateAiExecution(gameId) {
                  await tx.invalidateAiExecution(gameId);
                  failAt("execution invalidation");
                },
              }),
            ),
        },
      );
      const { snapshot } = await failing.createAi(principal, aiMatch);
      const cmd = turnCommand(snapshot);
      await expect(failing.aiTurn(principal, cmd, access())).rejects.toThrow(
        "Injected commit failure",
      );
      expect(await service(api).snapshot(principal, snapshot.gameId)).toEqual(snapshot);
      expect(await api.database.db.$count(moves, eq(moves.gameId, snapshot.gameId))).toBe(0);
      expect(
        await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
      ).toBe(0);
      expect(
        await api.database.db
          .select()
          .from(aiTurnReservations)
          .where(eq(aiTurnReservations.gameId, snapshot.gameId)),
      ).toMatchObject([{ state: "blocked" }]);
      expect(await service(api).invocations(principal, snapshot.gameId)).toMatchObject({
        turns: [
          {
            invalidOutputCount: 0,
            acceptedMovePly: null,
            attempts: [{ outcome: "in_flight", commentary: null }],
          },
        ],
      });
      await expect(
        service(api, { openai: adapter }).aiTurn(principal, cmd, access()),
      ).rejects.toMatchObject({ code: "AI_TURN_RECOVERY_REQUIRED" });
      expect(adapter.moveCalls).toBe(1);
    },
  );

  it("preserves a committed receipt when its acknowledgement is lost and suppresses redispatch after restart", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const adapter = createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] });
    const failing = service(
      api,
      { openai: adapter },
      {
        ...api.repository,
        async write(action) {
          const written = { acceptedMove: false };
          const result = await api.repository.write((tx) =>
            action({
              ...tx,
              async appendMove(move) {
                await tx.appendMove(move);
                written.acceptedMove = true;
              },
            }),
          );
          if (written.acceptedMove) throw new Error("Injected lost acknowledgement");
          return result;
        },
      },
    );
    const { snapshot } = await failing.createAi(principal, aiMatch);
    const cmd = turnCommand(snapshot);
    await expect(failing.aiTurn(principal, cmd, access())).rejects.toThrow(
      "Injected lost acknowledgement",
    );
    await harness.close(api);
    const restarted = await harness.createApi();
    const gamesService = service(restarted, { openai: adapter });
    const accepted = await gamesService.snapshot(principal, snapshot.gameId);
    expect(accepted).toMatchObject({ version: 1, moves: [{ uci: "e2e4" }] });
    expect(await gamesService.invocations(principal, snapshot.gameId)).toMatchObject({
      turns: [{ acceptedMovePly: 1, attempts: [{ outcome: "accepted" }] }],
    });
    await expect(gamesService.aiTurn(principal, cmd, access())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: accepted,
    });
    expect(adapter.moveCalls).toBe(1);
    expect(
      await restarted.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
  });

  it("keeps an uncertain reservation when failure cleanup cannot write, allowing only explicit lifecycle recovery", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = owner.principal;
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [
        () => {
          throw new Error("adapter-secret-sentinel");
        },
      ],
    });
    const failing = service(
      api,
      { openai: adapter },
      {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              async finishModelInvocation() {
                throw new Error("Injected outcome failure");
              },
              async blockAiTurn() {
                throw new Error("cleanup-secret-sentinel");
              },
            }),
          ),
      },
    );
    const { snapshot } = await failing.createAi(principal, aiMatch);
    const cmd = turnCommand(snapshot);
    await expect(failing.aiTurn(principal, cmd, access())).rejects.toThrow(
      "Injected outcome failure",
    );
    const recovered = service(await harness.createApi(), { openai: adapter });
    await expect(recovered.aiTurn(principal, cmd, access())).rejects.toMatchObject({
      code: "AI_TURN_IN_PROGRESS",
    });
    const paused = await recovered.lifecycle(principal, control(snapshot, "pause"));
    expect(paused).toMatchObject({ state: "paused", version: 1 });
    expect(
      await api.database.db.$count(
        aiTurnReservations,
        eq(aiTurnReservations.gameId, snapshot.gameId),
      ),
    ).toBe(0);
    expect(adapter.moveCalls).toBe(1);
  });

  it.each([false, true])(
    "survives a killed executor process without resetting a prior invalid-output budget (invalid first: %s)",
    async (invalidFirst) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = owner.principal;
      const { snapshot } = await service(api).createAi(principal, aiMatch);
      const cmd = turnCommand(snapshot);
      const child = fork(
        fileURLToPath(new URL("./providers/orphaned-turn.ts", import.meta.url)),
        [],
        {
          execArgv: ["--conditions=development", "--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const exited = once(child, "exit");
      try {
        const dispatched = Promise.race([
          once(child, "message", { signal: AbortSignal.timeout(5000) }),
          exited.then(() => {
            throw new Error("Executor exited before dispatch");
          }),
        ]);
        child.send({ command: cmd, guestSessionId: owner.id, invalidFirst });
        expect(await dispatched).toEqual(["dispatched", undefined]);
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      await harness.close(api);
      const restarted = await harness.createApi();
      const adapter = createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] });
      const gamesService = service(restarted, { openai: adapter });
      await restarted.database.db
        .update(aiTurnReservations)
        .set({ createdAt: sql`clock_timestamp() - interval '1 day'` })
        .where(eq(aiTurnReservations.gameId, snapshot.gameId));
      expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
      expect((await gamesService.unfinishedGame(principal)).game?.snapshot).toEqual(snapshot);
      for (const attempted of [cmd, turnCommand(snapshot)]) {
        await expect(gamesService.aiTurn(principal, attempted, access())).rejects.toMatchObject({
          code: "AI_TURN_IN_PROGRESS",
        });
      }
      expect(adapter.moveCalls).toBe(0);
      const before = await gamesService.invocations(principal, snapshot.gameId);
      const logicalTurnsBefore = await restarted.repository.read((reader) =>
        reader.getAiTurns(snapshot.gameId),
      );
      expect(before.turns[0]?.invalidOutputCount).toBe(invalidFirst ? 1 : 0);
      expect(before.turns[0]?.attempts.at(-1)?.outcome).toBe("in_flight");
      const paused = await gamesService.lifecycle(principal, control(snapshot, "pause"));
      expect(
        (await gamesService.invocations(principal, snapshot.gameId)).turns[0]?.attempts.at(-1)
          ?.outcome,
      ).toBe("interrupted");
      const resumed = await gamesService.lifecycle(principal, control(paused, "resume"));
      expect(
        await restarted.repository.read((reader) => reader.getAiTurns(snapshot.gameId)),
      ).toEqual(logicalTurnsBefore);
      await expect(gamesService.aiTurn(principal, cmd, access())).rejects.toMatchObject({
        code: "GAME_CONFLICT",
      });
      expect(await gamesService.aiTurn(principal, turnCommand(resumed), access())).toMatchObject({
        version: 3,
        moves: [{ uci: "e2e4" }],
      });
      expect(adapter.moveCalls).toBe(1);
      const after = await gamesService.invocations(principal, snapshot.gameId);
      expect(after.turns[0]).toMatchObject({
        id: before.turns[0]?.id,
        invalidOutputCount: invalidFirst ? 1 : 0,
        acceptedMovePly: 1,
      });
      expect(after.turns[0]?.attempts).toHaveLength(invalidFirst ? 3 : 2);
    },
  );
});
