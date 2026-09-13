import { createGame } from "@neurochess/chess";
import type { ChessColor } from "@neurochess/contracts";
import type { TFunction } from "i18next";

import type { PlayerSummaryData } from "../arena/panels/PlayerSummary";

export interface ReferenceScenario {
  readonly id: "humanHuman" | "aiHuman" | "humanAi" | "aiAi" | "identical";
  readonly label: string;
  readonly players: Readonly<Record<ChessColor, PlayerSummaryData["identity"]>>;
  readonly human: ChessColor | null;
  readonly canPause: boolean;
}

export function referenceScenarios(t: TFunction): readonly ReferenceScenario[] {
  const white = { kind: "human", name: t("reference.humanWhite") } as const;
  const black = { kind: "human", name: t("reference.humanBlack") } as const;
  const modelA = {
    kind: "ai",
    provider: t("reference.providerA"),
    model: t("reference.modelA"),
  } as const;
  const modelB = { ...modelA, provider: t("reference.providerB"), model: t("reference.modelB") };
  const longModel = { ...modelA, model: t("reference.longModel") };
  const scenarios = [
    { id: "humanHuman", players: { white, black }, human: "white", canPause: false },
    { id: "aiHuman", players: { white, black: modelB }, human: "white", canPause: true },
    { id: "humanAi", players: { white: modelA, black }, human: "black", canPause: true },
    { id: "aiAi", players: { white: modelA, black: modelB }, human: null, canPause: true },
    {
      id: "identical",
      players: { white: longModel, black: longModel },
      human: null,
      canPause: true,
    },
  ] satisfies Omit<ReferenceScenario, "label">[];
  return scenarios.map((scenario) => ({ ...scenario, label: t(`reference.${scenario.id}`) }));
}

export function createReferenceGame(replay: boolean) {
  const game = createGame();
  game.start();
  const moves = ["f2f3", "e7e5", "g2g4", "d8h4"];
  for (const move of moves.slice(0, replay ? 4 : 3)) {
    const result = game.playMove(move);
    if (!result.ok) throw new Error("Invalid arena reference history");
  }
  return game;
}

export const referenceMoveData = [
  { commentary: "commentaryOne", latencyMs: 2100, tokens: 840, costUsd: 0.0011 },
  { commentary: null, latencyMs: 2400, tokens: null, costUsd: null },
  { commentary: "commentaryThree", latencyMs: 1800, tokens: 960, costUsd: 0.0012 },
  { commentary: "commentaryFour", latencyMs: 2200, tokens: 1000, costUsd: null },
] as const;
