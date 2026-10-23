import type { AiExecutionTransaction } from "@neurochess/database";

import { AiTurnError } from "./errors.js";

export const CONTROLLER_LEASE_MS = 15_000;

export async function requireController(
  tx: Pick<AiExecutionTransaction, "getAiController">,
  gameId: string,
  controllerId?: string,
) {
  const lease = await tx.getAiController(gameId);
  if (!controllerId || lease?.controllerId !== controllerId.toLowerCase() || lease.expired) {
    throw new AiTurnError("AI_CONTROLLER_LOST");
  }
}
