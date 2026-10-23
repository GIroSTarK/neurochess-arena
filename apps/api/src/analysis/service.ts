import { createHash } from "node:crypto";

import { replayPositions } from "@neurochess/chess";
import {
  analysisQuerySchema,
  analysisReadResponseSchema,
  type AnalysisSample,
  analysisWriteRequestSchema,
  analysisWriteResponseSchema,
  gameIdSchema,
  type StoredAnalysisSample,
  storedAnalysisSampleSchema,
} from "@neurochess/contracts";
import type {
  GameRepository,
  GameStateReader,
  RoomReader,
  StoredAnalysisRecord,
  StoredGame,
} from "@neurochess/database";

import { authorizeGameRead } from "../games/authorization.js";
import { GameIntegrityError, GameRequestError } from "../games/errors.js";
import type { AccountPrincipal, Principal } from "../identity/principal.js";
import { lockPrincipal, requireActivePrincipal } from "../identity/validity.js";

import {
  AnalysisProfileObsoleteError,
  type AnalysisProfiles,
  analysisProfiles,
} from "./profiles.js";

export function createAnalysisService(
  repository: Pick<GameRepository, "read" | "write">,
  profiles: AnalysisProfiles = analysisProfiles,
) {
  const known = new Map(profiles.known.map((profile) => [profile.id, profile]));

  function account(principal: Principal): asserts principal is AccountPrincipal {
    if (principal.kind !== "account") throw new GameRequestError("UNAUTHORIZED");
  }

  async function authorize(
    reader: Pick<GameStateReader, "getParticipants"> & Pick<RoomReader, "hasRetainedRoomAccess">,
    principal: AccountPrincipal,
    game: StoredGame | undefined,
  ) {
    if (!game || game.isSandbox || game.mode === null) throw new GameRequestError("NOT_FOUND");
    authorizeGameRead(
      principal,
      game,
      await reader.getParticipants(game.id),
      false,
      game.mode === "human_vs_human"
        ? await reader.hasRetainedRoomAccess(game.id, principal.userId)
        : false,
    );
    return game;
  }

  function transport(record: StoredAnalysisRecord): StoredAnalysisSample {
    const profile = known.get(record.profileId);
    if (!profile || record.depth > profile.maxDepth || record.durationMs > profile.maxDurationMs) {
      throw new GameIntegrityError();
    }
    const parsed = storedAnalysisSampleSchema.safeParse({
      ply: record.ply,
      fen: record.fen,
      historyDigest: record.historyDigest,
      profileId: record.profileId,
      depth: record.depth,
      durationMs: record.durationMs,
      recordedAt: record.recordedAt.toISOString(),
      score:
        record.centipawns !== null
          ? { kind: "cp", value: record.centipawns }
          : { kind: "mate", winner: record.mateWinner, moves: record.mateMoves },
    });
    if (!parsed.success) throw new GameIntegrityError();
    return parsed.data;
  }

  function id(input: unknown) {
    const parsed = gameIdSchema.safeParse(input);
    if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
    return parsed.data.toLowerCase();
  }

  return {
    async read(principal: Principal, gameIdInput: unknown, input: unknown) {
      account(principal);
      const gameId = id(gameIdInput);
      const query = analysisQuerySchema.safeParse(input);
      if (!query.success) throw new GameRequestError("INVALID_REQUEST");
      const cursor = query.data.cursor?.split("_");
      if (
        cursor &&
        (cursor[0]?.toLowerCase() !== gameId || cursor[1]?.toLowerCase() !== principal.userId)
      ) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      return repository.read(async (reader) => {
        await requireActivePrincipal(reader, principal);
        await authorize(reader, principal, await reader.getGame(gameId));
        const records = await reader.getAnalysisSamples(
          principal.userId,
          gameId,
          query.data.limit + 1,
          cursor ? Number(cursor[2]) : undefined,
        );
        const samples = records.slice(0, query.data.limit).map(transport);
        const last = samples.at(-1);
        await requireActivePrincipal(reader, principal);
        return analysisReadResponseSchema.parse({
          gameId,
          samples,
          nextCursor:
            records.length > samples.length && last
              ? `${gameId}_${principal.userId}_${last.ply}`
              : null,
        });
      });
    },

    async write(principal: Principal, gameIdInput: unknown, input: unknown) {
      account(principal);
      const gameId = id(gameIdInput);
      const parsed = analysisWriteRequestSchema.safeParse(input);
      if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
      const samples = [...parsed.data.samples].sort((a, b) => a.ply - b.ply);
      return repository.write(async (tx) => {
        await requireActivePrincipal(tx, principal);
        const candidate = await authorize(tx, principal, await tx.getGame(gameId));
        // Mode is immutable. Discover it before locks so room writes enter the shared gate first.
        if (candidate.mode === "human_vs_human") await tx.lockSharedRooms();
        if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
        const game = await tx.lockGame(gameId);
        await requireActivePrincipal(tx, principal);
        await authorize(tx, principal, game);
        for (const sample of samples) {
          if (sample.profileId !== profiles.current.id) {
            throw new AnalysisProfileObsoleteError(profiles.current.id);
          }
          if (
            sample.depth > profiles.current.maxDepth ||
            sample.durationMs > profiles.current.maxDurationMs
          ) {
            throw new GameRequestError("INVALID_REQUEST");
          }
        }
        await verifyHistory(tx, gameId, samples);
        const retained: StoredAnalysisSample[] = [];
        for (const sample of samples) {
          const previous = await tx.lockAnalysisSample(principal.userId, gameId, sample.ply);
          if (previous) {
            const previousSample = transport(previous);
            if (previous.fen !== sample.fen || previous.historyDigest !== sample.historyDigest) {
              throw new GameIntegrityError();
            }
            const previousRank = known.get(previous.profileId)?.rank;
            if (previousRank === undefined) throw new GameIntegrityError();
            if (
              previousRank > profiles.current.rank ||
              (previousRank === profiles.current.rank && previous.depth >= sample.depth)
            ) {
              retained.push(previousSample);
              continue;
            }
          }
          const saved = await tx.saveAnalysisSample({
            userId: principal.userId,
            gameId,
            ply: sample.ply,
            fen: sample.fen,
            historyDigest: sample.historyDigest,
            profileId: sample.profileId,
            depth: sample.depth,
            durationMs: sample.durationMs,
            centipawns: sample.score.kind === "cp" ? sample.score.value : null,
            mateWinner: sample.score.kind === "mate" ? sample.score.winner : null,
            mateMoves: sample.score.kind === "mate" ? sample.score.moves : null,
          });
          retained.push(transport(saved));
        }
        // Session expiry during sample-row waits rolls back the whole batch, including replacements.
        await requireActivePrincipal(tx, principal);
        await authorize(tx, principal, game);
        return analysisWriteResponseSchema.parse({ gameId, samples: retained });
      });
    },
  };
}

async function verifyHistory(
  reader: Pick<GameStateReader, "getMoves">,
  gameId: string,
  samples: AnalysisSample[],
) {
  const history = await reader.getMoves(gameId);
  const lastPly = samples.at(-1)?.ply;
  if (lastPly === undefined) throw new GameRequestError("INVALID_REQUEST");
  if (lastPly > history.length) throw new GameRequestError("INVALID_REQUEST");
  const prefix = history.slice(0, lastPly);
  const targets = new Map(samples.map((sample) => [sample.ply, sample]));
  const moves = prefix.map((move) => move.uci);
  for (const result of replayPositions(moves)) {
    if (!result.ok) throw new GameIntegrityError();
    const position = result.value;
    const move = prefix[position.ply - 1];
    if (position.ply > 0 && (move?.ply !== position.ply || move.fen !== position.fen)) {
      throw new GameIntegrityError();
    }
    const sample = targets.get(position.ply);
    if (!sample) continue;
    const digest = createHash("sha256")
      .update(JSON.stringify(["standard-v1", ...moves.slice(0, sample.ply)]))
      .digest("hex");
    if (
      sample.fen !== position.fen ||
      sample.historyDigest !== digest ||
      (sample.score.kind === "mate" &&
        sample.score.moves === 0 &&
        (position.terminationReason !== "checkmate" || sample.score.winner === position.turn))
    ) {
      throw new GameRequestError("INVALID_REQUEST");
    }
  }
}

export type AnalysisService = ReturnType<typeof createAnalysisService>;
