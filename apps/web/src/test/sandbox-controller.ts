import type { GameSnapshot } from "@neurochess/contracts";
import { vi } from "vitest";

import { ApiFailure, type SandboxApi } from "../api/sandbox-client";
import type { PgnDelivery } from "../gameplay/pgn";
import { SandboxController, type SandboxGameNavigation } from "../sandbox/controller";

import { snapshot } from "./fixtures";

export function harness(
  initial = snapshot(),
  navigation?: SandboxGameNavigation,
  delivery?: PgnDelivery,
) {
  const api = {
    ready: vi.fn<SandboxApi["ready"]>().mockResolvedValue(true),
    bootstrap: vi.fn<SandboxApi["bootstrap"]>().mockResolvedValue(),
    create: vi.fn<SandboxApi["create"]>().mockResolvedValue(initial),
    snapshot: vi.fn<SandboxApi["snapshot"]>().mockResolvedValue(initial),
    move: vi.fn<SandboxApi["move"]>().mockResolvedValue(snapshot(["e2e4"])),
    lifecycle: vi.fn<SandboxApi["lifecycle"]>().mockResolvedValue(initial),
    unfinished: vi.fn<SandboxApi["unfinished"]>().mockResolvedValue(null),
    replay: vi.fn<SandboxApi["replay"]>().mockRejectedValue(new ApiFailure("network")),
    pgn: vi
      .fn<SandboxApi["pgn"]>()
      .mockResolvedValue({ gameId: initial.gameId, version: initial.version, pgn: initial.pgn }),
  };
  const ids = vi.fn(() => crypto.randomUUID());
  const controller = new SandboxController(api, ids, navigation, delivery);
  return { api, controller, ids, initial };
}

export async function started(initial = snapshot()) {
  const result = harness(initial);
  await enterSandbox(result.controller);
  await result.controller.start();
  return result;
}

export function enterSandbox(controller: SandboxController, snapshot: GameSnapshot | null = null) {
  return controller.enter({
    target: snapshot ? { kind: "game", gameId: snapshot.gameId } : { kind: "none" },
    snapshot,
    readiness: true,
  });
}
