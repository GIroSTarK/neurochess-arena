import { aiTurnCommandSchema, gameIdSchema } from "@neurochess/contracts";
import { createGameRepository } from "@neurochess/database";
import { z } from "zod";

import { integrationDatabase } from "../../../../test/database.js";
import { createGameService } from "../../src/games/service.js";

import { createScriptedAdapter } from "./scripted-adapter.js";

// A separate process lets the parent kill an executor after dispatch, without running cleanup.
process.once("message", (message: unknown) => {
  void execute(message);
});

async function execute(message: unknown) {
  const database = integrationDatabase();
  try {
    const { command, guestSessionId } = z
      .strictObject({
        command: aiTurnCommandSchema,
        guestSessionId: gameIdSchema,
      })
      .parse(message);
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [
        () => {
          process.send?.("dispatched");
          return Promise.withResolvers<never>().promise;
        },
      ],
    });
    const service = createGameService(createGameRepository(database), {
      nodeEnv: "test",
      sandboxEnabled: false,
      aiAdapters: { openai: adapter },
    });
    await service.aiTurn({ guestSessionId }, command, {
      apiKey: "child-fixture-only",
      signal: new AbortController().signal,
    });
  } catch {
    process.send?.("failed");
  } finally {
    await database.close();
    process.disconnect();
  }
}
