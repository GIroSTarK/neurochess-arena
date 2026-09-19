import type { FastifyReply, FastifyRequest } from "fastify";

export const DISCOVERY_TIMEOUT_MS = 30_000;
export const AI_TURN_TIMEOUT_MS = 180_000;

export function providerRequestScope(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  const closed = () => {
    if (!reply.raw.writableFinished) disconnect();
  };
  request.raw.once("aborted", disconnect);
  reply.raw.once("close", closed);
  if ((request.raw.destroyed && !request.raw.complete) || reply.raw.destroyed) disconnect();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Provider operation timed out", "TimeoutError")),
    timeoutMs,
  );
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      request.raw.removeListener("aborted", disconnect);
      reply.raw.removeListener("close", closed);
    },
  };
}
