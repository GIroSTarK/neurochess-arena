import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import { games } from "@neurochess/database";
import { inArray } from "drizzle-orm";

import { integrationDatabase } from "../../../test/database.js";
import { positionOf, transportSnapshot } from "../src/games/command-persistence.js";
import { createGameService } from "../src/games/service.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { FOOLS_MATE } from "./helpers.js";

export class RoomHistoryHarness extends AccountGameHarness {
  private readonly roomIds: string[] = [];

  async room(
    options: {
      state?: "active" | "waiting" | "completed" | "aborted";
      guest?: boolean;
      ownerColor?: "white" | "black";
    } = {},
  ) {
    const api = await this.createAuthenticatedApi();
    const owner = await this.account(api);
    const opponent = options.guest ? await this.guest(api) : await this.account(api);
    const ownerColor = options.ownerColor ?? "white";
    const state = options.state ?? "completed";
    const gameId = randomUUID();
    this.roomIds.push(gameId);
    const domain = createGame();
    domain.start();
    if (state === "waiting") domain.pause();
    if (state === "completed") for (const move of FOOLS_MATE) domain.playMove(move);
    if (state === "aborted") domain.abort();
    const snapshot = transportSnapshot(gameId, domain.snapshot().moves.length, domain.snapshot());
    await api.repository.write(async (tx) => {
      await tx.insertGame(
        {
          id: gameId,
          ownerUserId: owner.principal.userId,
          mode: "human_vs_human",
          ...positionOf(snapshot),
        },
        (["white", "black"] as const).map((color) => ({
          gameId,
          color,
          seatType: "human",
          ...(color === ownerColor
            ? { userId: owner.principal.userId }
            : state === "waiting"
              ? {}
              : opponent.principal.kind === "account"
                ? { userId: opponent.principal.userId }
                : { guestSessionId: opponent.principal.guestSessionId }),
        })),
      );
      await tx.insertRoom({
        gameId,
        ownerColor,
        state: state === "waiting" ? "waiting" : "joined",
        joinedAt: state === "waiting" ? null : new Date(),
        invitationDigest: state === "waiting" ? gameId.replaceAll("-", "").repeat(2) : null,
      });
      for (const move of snapshot.moves) {
        const commandId = randomUUID();
        await tx.appendMove({ ...move, gameId, commandId, version: move.ply });
        await tx.appendCommand({ gameId, commandId, kind: "move", version: move.ply });
      }
    });
    const service = createGameService(api.repository, { nodeEnv: "test", sandboxEnabled: false });
    return { api, owner, opponent, snapshot, service };
  }

  override async dispose() {
    const db = integrationDatabase();
    try {
      if (this.roomIds.length) {
        await db.db.delete(games).where(inArray(games.id, this.roomIds.splice(0)));
      }
    } finally {
      await db.close();
      await super.dispose();
    }
  }
}
