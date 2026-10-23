import type { GameCommandIdentity } from "@neurochess/contracts";
import type {
  GameStateTransaction,
  IdentityTransaction,
  RoomTransaction,
  StoredGame,
} from "@neurochess/database";

import type { Principal } from "../identity/principal.js";
import { lockPrincipal, requireActivePrincipal } from "../identity/validity.js";

import { GameConflictError, GameRequestError } from "./errors.js";
import {
  type GameRestorationReader,
  restoreAuthorizedGame,
  type RestoredGame,
} from "./restoration.js";

export type CommandPreparationTransaction = IdentityTransaction &
  GameRestorationReader &
  Pick<GameStateTransaction, "getGame" | "lockGame" | "hasCommand"> &
  Pick<RoomTransaction, "lockSharedRooms">;

export interface PreparedGameCommand extends RestoredGame {
  readonly stored: StoredGame;
}

export interface CommandPreparationOptions {
  readonly sandboxEnabled: boolean;
  readonly allowRoomCommands: boolean;
}

export async function prepareGameCommand(
  tx: CommandPreparationTransaction,
  principal: Principal,
  identity: GameCommandIdentity,
  options: CommandPreparationOptions,
): Promise<PreparedGameCommand> {
  if ((await tx.getGame(identity.gameId))?.mode === "human_vs_human") await tx.lockSharedRooms();
  if (!(await lockPrincipal(tx, principal))) {
    throw new GameRequestError("UNAUTHORIZED");
  }
  const stored = await tx.lockGame(identity.gameId);
  await requireActivePrincipal(tx, principal);
  if (!stored) throw new GameRequestError("NOT_FOUND");
  const restored = await restoreAuthorizedGame(tx, principal, stored, options.sandboxEnabled);
  if (stored.mode === "human_vs_human" && !options.allowRoomCommands) {
    throw new GameRequestError("FORBIDDEN");
  }
  // Accepted IDs span every command kind, including retries after completion.
  if (
    identity.expectedVersion !== stored.version ||
    (await tx.hasCommand(stored.id, identity.commandId.toLowerCase()))
  ) {
    throw new GameConflictError(restored.snapshot);
  }
  return { ...restored, stored };
}
