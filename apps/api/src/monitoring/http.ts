import { performance } from "node:perf_hooks";

import { emptyQuerySchema, operationsSnapshotSchema } from "@neurochess/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { observe, type Operations } from "./operations.js";

export interface ReadinessProbe {
  check(): Promise<void>;
  poolStats?(): { total: number; waiting: number };
}

export function registerOperations(
  app: FastifyInstance,
  operations: Operations,
  readiness: ReadinessProbe,
) {
  const starts = new WeakMap<FastifyRequest, number>();
  let ready: boolean | undefined;
  async function check() {
    let next = false;
    try {
      await readiness.check();
      next = true;
    } catch {
      /* Availability only; no database details. */
    }
    observe(operations, (sink) => sink.gauge("databaseReady", Number(next)));
    if (next !== ready) {
      ready = next;
      app.log.info(
        { event: "database_readiness", state: next ? "ready" : "unavailable" },
        "Operational state changed",
      );
    }
    return next;
  }
  app.addHook("onListen", async () => {
    app.log.info({ event: "api_listening" }, "Operational state changed");
  });
  app.addHook("onReady", async () => {
    app.log.info({ event: "api_starting" }, "Operational state changed");
  });
  app.addHook("preClose", async () => {
    app.log.info({ event: "api_stopping" }, "Operational state changed");
  });
  app.addHook("onRequest", async (request) => {
    starts.set(request, performance.now());
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    if (["/health", "/ready", "/internal/operations"].includes(route ?? "")) return;
    const duration = Math.max(0, performance.now() - (starts.get(request) ?? performance.now()));
    observe(operations, (sink) => {
      sink.increment("httpResponses");
      sink.increment("httpDurationMs", duration);
      if (reply.statusCode >= 500) sink.increment("httpServerFailures");
      else if (reply.statusCode === 429) sink.increment("httpLimited");
      else if (reply.statusCode >= 400) sink.increment("httpRejected");
      if (duration > 2000 && route !== "/games/:gameId/ai-turn" && route !== "/providers/models") {
        sink.increment("httpSlow");
      }
      if (route === "/games/:gameId/analysis") {
        sink.increment(request.method === "POST" ? "analysisWrites" : "analysisReads");
        if (reply.statusCode >= 500) sink.increment("analysisFailures");
      }
    });
  });
  app.withTypeProvider<ZodTypeProvider>().get(
    "/internal/operations",
    {
      onRequest: async (request, reply) => {
        // Verify the actual peer, never a proxy-derived IP. A browser or forwarded request cannot scrape.
        if (
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
            request.raw.socket.remoteAddress ?? "",
          ) ||
          ["origin", "forwarded", "x-forwarded-for", "x-real-ip"].some(
            (header) => request.headers[header] !== undefined,
          )
        ) {
          return reply.code(404).send(null);
        }
      },
      schema: {
        querystring: emptyQuerySchema,
        response: { 200: operationsSnapshotSchema, 404: z.null(), 503: z.null() },
      },
    },
    async (_request, reply) => {
      await check();
      try {
        const pool = readiness.poolStats?.();
        if (pool) {
          operations.gauge("poolWaiting", pool.waiting);
          operations.gauge("poolTotal", pool.total);
        }
        return operations.snapshot();
      } catch {
        return reply.code(503).send(null);
      }
    },
  );
  return check;
}
