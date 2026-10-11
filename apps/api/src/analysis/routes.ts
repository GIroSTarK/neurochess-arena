import {
  analysisObsoleteResponseSchema,
  analysisQuerySchema,
  analysisReadResponseSchema,
  analysisWriteRequestSchema,
  analysisWriteResponseSchema,
  emptyQuerySchema,
  gameParamsSchema,
} from "@neurochess/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { AccountAuth } from "../auth/service.js";
import { GameRequestError } from "../games/errors.js";
import { gameErrorResponses, handleGameError } from "../games/http.js";
import type { GuestService } from "../guests/service.js";
import { publicPrincipalFor } from "../identity/http.js";

import { AnalysisProfileObsoleteError } from "./profiles.js";
import type { AnalysisService } from "./service.js";

export async function registerAnalysisRoutes(
  app: FastifyInstance,
  options: {
    readonly auth?: AccountAuth;
    readonly guests: GuestService;
    readonly analysis: AnalysisService;
    readonly webOrigin: string;
  },
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new GameRequestError("FORBIDDEN");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AnalysisProfileObsoleteError) {
      return reply.code(409).send(
        analysisObsoleteResponseSchema.parse({
          code: "profile_obsolete",
          currentProfileId: error.currentProfileId,
          requestId: request.id,
        }),
      );
    }
    return handleGameError(error, request, reply);
  });
  routes.get(
    "/games/:gameId/analysis",
    {
      schema: {
        params: gameParamsSchema,
        querystring: analysisQuerySchema,
        response: { 200: analysisReadResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.analysis.read(
        await publicPrincipalFor(options, request, reply, true),
        request.params.gameId,
        request.query,
      ),
  );
  routes.post(
    "/games/:gameId/analysis",
    {
      bodyLimit: 65_536,
      schema: {
        params: gameParamsSchema,
        querystring: emptyQuerySchema,
        body: analysisWriteRequestSchema,
        response: {
          200: analysisWriteResponseSchema,
          ...gameErrorResponses,
          409: analysisObsoleteResponseSchema,
        },
      },
    },
    async (request, reply) =>
      options.analysis.write(
        await publicPrincipalFor(options, request, reply, true),
        request.params.gameId,
        request.body,
      ),
  );
}
