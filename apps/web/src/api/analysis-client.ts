import {
  analysisObsoleteResponseSchema,
  analysisQuerySchema,
  analysisReadResponseSchema,
  type AnalysisSample,
  analysisWriteRequestSchema,
  analysisWriteResponseSchema,
  gameErrorResponseSchema,
  gameParamsSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import { ApiFailure } from "./failures";
import { apiOrigin, createHttpRequest, validated } from "./http";
import type { PublicIdentity } from "./identity";

export class AnalysisProfileObsolete extends Error {
  constructor() {
    super("profile_obsolete");
  }
}

export function createAnalysisApi(
  baseUrl: string,
  identity: PublicIdentity,
  fetcher?: typeof fetch,
) {
  const malformed = () => new ApiFailure("malformed");
  const request = createHttpRequest({
    baseUrl: apiOrigin(baseUrl, malformed),
    ...(fetcher ? { fetch: fetcher } : {}),
    signal: identity.signal,
    headers: {
      "x-neurochess-identity": "account",
      ...(identity.expectedAccount
        ? { "x-neurochess-expected-account": identity.expectedAccount }
        : {}),
    },
    async beforeRequest() {
      if (
        identity.intent !== "account" ||
        !identity.expectedAccount ||
        identity.expectedAccount === "guest"
      ) {
        throw new ApiFailure("api", "UNAUTHORIZED");
      }
      await identity.verify();
    },
    afterResponse: () => identity.verify(),
    errors: {
      schema: z.union([gameErrorResponseSchema, analysisObsoleteResponseSchema]),
      failure: (kind) => new ApiFailure(kind),
      isFailure: (error): error is Error =>
        error instanceof ApiFailure || error instanceof AnalysisProfileObsolete,
      fromResponse(error) {
        if (error.code === "profile_obsolete") return new AnalysisProfileObsolete();
        if (error.code === "UNAUTHORIZED" || error.code === "PROFILE_REQUIRED") identity.lost?.();
        return new ApiFailure("api", error.code);
      },
    },
  });
  const key = (gameId: string) =>
    validated(gameParamsSchema, { gameId }, malformed).gameId.toLowerCase();
  return {
    async read(this: void, gameId: string, cursor: string | undefined, signal: AbortSignal) {
      const id = key(gameId);
      const query = validated(
        analysisQuerySchema,
        { limit: 128, ...(cursor ? { cursor } : {}) },
        malformed,
      );
      const search = new URLSearchParams({
        limit: String(query.limit),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      const result = await request(
        `/games/${id}/analysis?${search}`,
        analysisReadResponseSchema,
        signal,
      );
      let previous = cursor ? Number(cursor.split("_")[2]) : -1;
      if (result.gameId !== id) throw malformed();
      for (const sample of result.samples) {
        if (sample.ply <= previous) throw malformed();
        previous = sample.ply;
      }
      if (
        result.nextCursor &&
        (result.samples.length === 0 ||
          result.nextCursor !== `${id}_${identity.expectedAccount ?? ""}_${previous}`)
      ) {
        throw malformed();
      }
      return result;
    },
    async write(
      this: void,
      gameId: string,
      samples: readonly AnalysisSample[],
      signal: AbortSignal,
    ) {
      const id = key(gameId);
      const body = validated(analysisWriteRequestSchema, { samples }, malformed);
      const result = await request(
        `/games/${id}/analysis`,
        analysisWriteResponseSchema,
        signal,
        body,
      );
      const submitted = new Map(body.samples.map((sample) => [sample.ply, sample]));
      if (result.gameId !== id || result.samples.length !== submitted.size) throw malformed();
      for (const sample of result.samples) {
        const original = submitted.get(sample.ply);
        if (sample.fen !== original?.fen || sample.historyDigest !== original.historyDigest) {
          throw malformed();
        }
        submitted.delete(sample.ply);
      }
      return result;
    },
  };
}

export type AnalysisApi = ReturnType<typeof createAnalysisApi>;
