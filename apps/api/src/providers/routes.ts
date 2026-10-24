import {
  aiErrorResponseSchema,
  emptyQuerySchema,
  modelDiscoveryRequestSchema,
  modelDiscoveryResultSchema,
} from "@neurochess/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { AccountAuth } from "../auth/service.js";
import { GameRequestError } from "../games/errors.js";
import { gameErrorResponses, handleGameError } from "../games/http.js";
import type { GuestService } from "../guests/service.js";
import { publicPrincipalFor } from "../identity/http.js";

import type { ProviderModelService } from "./model-service.js";
import { DISCOVERY_TIMEOUT_MS, providerRequestScope } from "./request-scope.js";

export interface ProviderApiOptions {
  readonly auth?: AccountAuth;
  readonly models: ProviderModelService;
  readonly guests: GuestService;
  readonly webOrigin: string;
  readonly discoveryTimeoutMs?: number;
}

export async function registerProviderRoutes(
  app: FastifyInstance,
  options: ProviderApiOptions,
): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new GameRequestError("FORBIDDEN");
    }
  });
  app.setErrorHandler(handleGameError);

  routes.post(
    "/providers/models",
    {
      schema: {
        body: modelDiscoveryRequestSchema,
        querystring: emptyQuerySchema,
        response: {
          200: modelDiscoveryResultSchema,
          ...gameErrorResponses,
          409: aiErrorResponseSchema,
          422: aiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = await publicPrincipalFor(options, request, reply);
      const scope = providerRequestScope(
        request,
        reply,
        options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
      );
      try {
        return await options.models(principal, request.body.provider, {
          ...("apiKey" in request.body
            ? { apiKey: request.body.apiKey }
            : { credentialId: request.body.credentialId }),
          signal: scope.signal,
        });
      } finally {
        if ("apiKey" in request.body) request.body.apiKey = "";
        scope.dispose();
      }
    },
  );
}
