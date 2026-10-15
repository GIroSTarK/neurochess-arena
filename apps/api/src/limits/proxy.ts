import { isIP } from "node:net";

import type { FastifyInstance, FastifyRequest } from "fastify";

export function normalizedIp(value: string): string {
  if (isIP(value) !== 6) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped?.[1] || !mapped[2]) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

export function clientIp(request: FastifyRequest): string {
  return normalizedIp(request.ip);
}

// IPv6 privacy addresses in the same /64 share anonymous abuse budgets.
export function ipBudgetKey(ip: string): string {
  const value = normalizedIp(ip);
  if (isIP(value) !== 6) return value;
  const [left, right] = value.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const groups = value.includes("::")
    ? [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end]
    : start;
  return (
    groups
      .slice(0, 4)
      .map((group) => group.padStart(4, "0"))
      .join(":") + "::/64"
  );
}

export function proxyTrust(proxyIp?: string) {
  const expected = proxyIp ? normalizedIp(proxyIp) : undefined;
  return (address: string, hop: number) =>
    expected !== undefined && hop === 0 && normalizedIp(address) === expected;
}

export function registerProxyBoundary(app: FastifyInstance, proxyIp?: string) {
  const trusted = proxyTrust(proxyIp);
  app.addHook("onRequest", async (request, reply) => {
    if (!trusted(request.raw.socket.remoteAddress ?? "", 0)) return;
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded !== "string" || forwarded.includes("%") || !isIP(forwarded)) {
      return reply.code(400).header("Cache-Control", "no-store").serializer(JSON.stringify).send({
        code: "INVALID_REQUEST",
        message: "The request could not be accepted.",
        requestId: request.id,
      });
    }
  });
}
