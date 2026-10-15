import type { FastifyInstance } from "fastify";

export function registerSecurityHeaders(app: FastifyInstance) {
  // Install at the root before admission/CORS so early errors are private too.
  app.addHook("onSend", async (_request, reply) => {
    reply.headers({
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-site",
    });
  });
}
