import type { AnalysisTarget } from "../analysis/protocol";
import type { EngineWorker } from "../analysis/worker-client";

export const initialTarget: AnalysisTarget = {
  lifetime: "view-1",
  gameId: "f0cfe67b-38a0-4e83-aec4-96c81ef479b7",
  ply: 0,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  moves: [],
  historyDigest: "c562a09adf818d7f7223abf87a2269ecbfd58b5bf3660bcda356df2eb6cbdff5",
  profileId: "sf19-lite-single-v1",
};

export function fakeEngine() {
  const commands: string[] = [];
  let terminated = false;
  const worker: EngineWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (command) => commands.push(command),
    terminate: () => {
      terminated = true;
    },
  };
  const emit = (data: unknown) => worker.onmessage?.({ data } as MessageEvent);
  return {
    worker,
    commands,
    emit,
    terminated: () => terminated,
    initialize() {
      for (const line of [
        "option name Threads type spin default 1 min 1 max 1",
        "option name Hash type spin default 16 min 1 max 33554432",
        "option name MultiPV type spin default 1 min 1 max 256",
        "option name Ponder type check default false",
        "option name UCI_LimitStrength type check default false",
        "option name Skill Level type spin default 20 min 0 max 20",
        "option name UCI_Chess960 type check default false",
        "uciok",
        "readyok",
      ]) {
        emit(line);
      }
    },
  };
}

export async function settle() {
  for (let index = 0; index < 20; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
import { createHash } from "node:crypto";

import { vi } from "vitest";

export function deterministicDigest() {
  // Scheduling tests control promise delivery; protocol and browser tests use
  // native WebCrypto, whose thread-pool completion is unrelated to fake time.
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (_algorithm, bytes) => {
    const input = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
    return Uint8Array.from(createHash("sha256").update(input).digest()).buffer;
  });
}
