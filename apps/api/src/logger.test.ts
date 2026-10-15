import pino from "pino";
import { describe, expect, it } from "vitest";

import { createLoggerOptions } from "./logger.js";

describe("secret-safe logging", () => {
  it("drops private operational content, dynamic paths and untrusted error diagnostics", () => {
    const chunks: string[] = [];
    const logger = pino(createLoggerOptions("info"), {
      write: (chunk: string) => chunks.push(chunk),
    });
    const canary = "private-monitoring-canary";
    logger.error(
      {
        err: { name: canary, code: canary },
        req: { method: "GET", url: `/games/${canary}/analysis` },
        nested: {
          gameId: canary,
          username: canary,
          email: canary,
          fen: canary,
          pgn: canary,
          prompt: canary,
          commentary: canary,
        },
      },
      "Request failed",
    );
    expect(chunks.join("")).not.toContain(canary);
    expect(JSON.parse(chunks.join(""))).toHaveProperty("err.name", "UnknownError");
  });
  it("redacts invitation fields and unexpected room URL segments, queries and fragments", () => {
    const chunks: string[] = [];
    const invitation = "invitation-canary-secret";
    const logger = pino(createLoggerOptions("info"), {
      write(chunk: string) {
        chunks.push(chunk);
      },
    });
    for (const path of [
      `/rooms/join/${invitation}`,
      `/rooms/join#invite=${invitation}`,
      `/rooms/invitations/resolve?invitation=${invitation}`,
    ]) {
      logger.info(
        {
          req: { method: "POST", url: path },
          nested: {
            invitation,
            invitationDigest: invitation,
            invite: invitation,
            joinedInvitationDigest: invitation,
          },
        },
        "room request",
      );
    }
    expect(chunks.join("")).not.toContain(invitation);
  });
  it("omits protocol tokens embedded in authentication paths", () => {
    const chunks: string[] = [];
    const logger = pino(createLoggerOptions("info"), {
      write(chunk: string) {
        chunks.push(chunk);
      },
    });
    logger.info(
      {
        req: {
          method: "GET",
          url: "/api/auth/reset-password/path-token-canary?callbackURL=secret",
        },
      },
      "incoming request",
    );
    expect(chunks.join("")).not.toContain("path-token-canary");
    expect(JSON.parse(chunks.join(""))).toHaveProperty("req.path", "/api/auth/[Redacted]");
  });
  it("preserves error diagnostics across formatting and serialization", () => {
    const chunks: string[] = [];
    const canary = "error-diagnostics-canary-secret";
    const logger = pino(createLoggerOptions("info"), {
      write(chunk: string) {
        chunks.push(chunk);
      },
    });
    const error = Object.assign(new TypeError(canary, { cause: new Error(canary) }), {
      code: "ECONNREFUSED",
      providerResponse: canary,
    });

    logger.error({ err: error, nested: { err: error } }, "provider request failed");

    const output = chunks.join("");
    const diagnostics = { code: "ECONNREFUSED", name: "TypeError" };
    expect(JSON.parse(output)).toHaveProperty("err", diagnostics);
    expect(JSON.parse(output)).toHaveProperty("nested.err", diagnostics);
    expect(output).not.toContain(canary);
  });

  it.each([
    { name: "null error", error: null },
    { name: "string error", error: "unrecognized failure" },
    { name: "non-string name and code", error: { name: 123, code: 456 } },
  ])("uses safe error fallback: $name", ({ error }) => {
    const chunks: string[] = [];
    const logger = pino(createLoggerOptions("info"), {
      write(chunk: string) {
        chunks.push(chunk);
      },
    });

    logger.error({ err: error }, "request failed");

    expect(JSON.parse(chunks.join(""))).toHaveProperty("err", { name: "UnknownError" });
  });

  it("removes nested credentials, raw errors, and URL queries", () => {
    const chunks: string[] = [];
    const canary = "phase-zero-canary-secret";
    const destination = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };
    const logger = pino(createLoggerOptions("info"), destination);

    logger.info(
      {
        err: new Error(canary),
        nested: {
          credential: { accessToken: canary },
          requestUrl: `https://example.test/provider?token=${canary}`,
        },
        req: {
          headers: { authorization: `Bearer ${canary}`, cookie: `session=${canary}` },
          method: "GET",
          url: `/health?apiKey=${canary}`,
        },
      },
      "redaction check",
    );

    const output = chunks.join("");
    expect(output).not.toContain(canary);
    expect(output).not.toContain("?token=");
    expect(output).not.toContain("?apiKey=");
    expect(output).toContain("[Redacted]");
  });
});
