import { authErrorResponseSchema, rateLimitResponseSchema } from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Principal } from "../identity/principal.js";
import { requestLimitMessage } from "../locales/en.js";

import { createCounter } from "./counter.js";
import {
  type RequestBudget,
  requestPolicies,
  type RequestPolicy,
  requestPolicy,
} from "./policy.js";
import { clientIp, ipBudgetKey } from "./proxy.js";

export interface RequestLimitOptions {
  now?: () => number;
  capacity?: number;
  policies?: Partial<Record<RequestPolicy, RequestBudget>>;
}

class RequestRateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super("RATE_LIMITED");
  }
}

declare module "fastify" {
  interface FastifyInstance {
    enforcePrincipalLimit(request: FastifyRequest, principal: Principal): void;
  }
}

export function enforcePrincipalLimit(request: FastifyRequest, principal: Principal) {
  request.server.enforcePrincipalLimit(request, principal);
}

export function sendRateLimit(request: FastifyRequest, reply: FastifyReply, seconds: number) {
  return reply
    .code(429)
    .header("Retry-After", String(seconds))
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .send({
      code: "RATE_LIMITED",
      message: requestLimitMessage,
      requestId: request.id,
    });
}

export function handleRateLimitError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (!(error instanceof RequestRateLimitError)) return false;
  sendRateLimit(request, reply, error.retryAfter);
  return true;
}

export function registerRequestLimits(app: FastifyInstance, options: RequestLimitOptions = {}) {
  const budgets = Object.fromEntries(
    Object.entries(requestPolicies).map(([name, defaults]) => {
      const policy = options.policies?.[name as RequestPolicy] ?? defaults;
      return [
        name,
        {
          ip: createCounter(policy.ip, 60_000, options.capacity, options.now),
          principal: createCounter(policy.principal, 60_000, options.capacity, options.now),
          inFlight: 0,
          maxInFlight: policy.inFlight,
        },
      ];
    }),
  ) as Record<
    RequestPolicy,
    {
      ip: ReturnType<typeof createCounter>;
      principal: ReturnType<typeof createCounter>;
      inFlight: number;
      maxInFlight: number;
    }
  >;
  const releases = new WeakMap<FastifyRequest, () => void>();
  const counted = new WeakSet<FastifyRequest>();
  app.decorate("enforcePrincipalLimit", (request: FastifyRequest, principal: Principal) => {
    if (counted.has(request)) return;
    const identity =
      principal.kind === "account"
        ? `account:${principal.userId}`
        : `guest:${principal.guestSessionId}`;
    const wait =
      budgets[requestPolicy(request.method, request.routeOptions.url)].principal.consume(identity);
    if (wait) throw new RequestRateLimitError(wait);
    counted.add(request);
  });
  app.addHook("onRoute", (route) => {
    // One transport-level rejection contract also covers failures before parsing/authentication.
    const responses = route.schema?.response as Record<string, unknown> | undefined;
    route.schema = {
      ...route.schema,
      response: {
        ...responses,
        429:
          route.url === "/api/auth/*"
            ? rateLimitResponseSchema.or(authErrorResponseSchema)
            : rateLimitResponseSchema,
      },
    };
  });
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    if (
      (route === "/health" || route === "/ready") &&
      ["127.0.0.1", "::1"].includes(clientIp(request))
    ) {
      return;
    }
    const budget = budgets[requestPolicy(request.method, route)];
    const wait = budget.ip.consume(ipBudgetKey(clientIp(request)));
    if (wait) return sendRateLimit(request, reply, wait);
    if (budget.maxInFlight === 0) return;
    if (budget.inFlight >= budget.maxInFlight) return sendRateLimit(request, reply, 1);
    budget.inFlight++;
    const release = () => {
      budget.inFlight--;
      releases.delete(request);
      reply.raw.off("close", release);
    };
    releases.set(request, release);
    reply.raw.once("close", release);
  });
  app.addHook("onResponse", async (request) => releases.get(request)?.());
  app.addHook("onTimeout", async (request) => releases.get(request)?.());
  app.addHook("onRequestAbort", async (request) => releases.get(request)?.());
}
