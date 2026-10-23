import type {
  AiProvider,
  ChessColor,
  GameDetails,
  ProviderCredentialSource,
} from "@neurochess/contracts";
import { vi } from "vitest";

import { AiRequestFailure } from "../api/ai-client";
import { createMatchComposition } from "../match/composition";
import type { SessionCredentials } from "../match/seat-credentials";
import type { MatchSession } from "../match/session";

import { snapshot } from "./fixtures";
import { createMatchApiFixture } from "./match-api";

const seat = { type: "ai", provider: "openai", modelId: "fixture", parameters: {} } as const;
export function matchDetails(human?: ChessColor): GameDetails {
  return {
    snapshot: snapshot(),
    configuration: human
      ? {
          mode: "ai_vs_human",
          seats:
            human === "white"
              ? { white: { type: "human" }, black: seat }
              : { white: seat, black: { type: "human" } },
        }
      : { mode: "ai_vs_ai", seats: { white: seat, black: seat } },
  };
}

// Replace only the browser-owned secret container; every gameplay collaborator stays real.
function memoryCredentials(signal: AbortSignal): SessionCredentials {
  const values = new Map<ChessColor, { provider: AiProvider; source: ProviderCredentialSource }>();
  const clear = () => values.clear();
  let disposed = false;
  const dispose = () => {
    disposed = true;
    clear();
    signal.removeEventListener("abort", dispose);
  };
  signal.addEventListener("abort", dispose, { once: true });
  function put(color: ChessColor, provider: AiProvider, source: ProviderCredentialSource) {
    if (disposed) throw new AiRequestFailure("AI_KEY_REQUIRED");
    values.set(color, { provider, source });
  }
  return {
    signal,
    clear,
    dispose,
    set: (color, provider, apiKey) => put(color, provider, { apiKey }),
    setSaved: (color, provider, credentialId) => put(color, provider, { credentialId }),
    remove: (color) => {
      values.delete(color);
    },
    require: (color, provider) => {
      const value = values.get(color);
      if (value?.provider !== provider) throw new AiRequestFailure("AI_KEY_REQUIRED");
      return { ...value.source };
    },
  };
}

const sessions: MatchSession[] = [];
export function cleanupMatches() {
  sessions.splice(0).forEach((session) => session.endLifetime());
}

export function matchHarness(initial = matchDetails()) {
  const { api, readSnapshot, seedSnapshot } = createMatchApiFixture(initial);
  const delivery = { copy: vi.fn().mockResolvedValue(true), download: vi.fn() };
  const composition = createMatchComposition({
    api,
    delivery,
    createCredentials: memoryCredentials,
  });
  const { session, seats } = composition;
  sessions.push(session);
  void session.enter({ kind: "setup" });
  return {
    api,
    ...composition,
    seed: seedSnapshot,
    enter: () =>
      session.enter({
        kind: "game",
        gameId: readSnapshot().gameId,
        details: { ...initial, snapshot: readSnapshot() },
      }),
    keys: () => {
      seats.current?.set("white", "openai", "white-secret-sentinel");
      seats.current?.set("black", "openai", "black-secret-sentinel");
    },
  };
}
