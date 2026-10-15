import type { LoggerOptions } from "pino";

const redactedValue = "[Redacted]";
const secretKeyPattern =
  /api[-_]?key|authorization|cookie|credential|database[-_]?url|password|secret|session|token|invitation|invite|gameId|userId|username|email|prompt|commentary|(^|_)(fen|pgn)($|_)/i;
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "ZodError",
]);
const errorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "23505",
  "23503",
  "40001",
  "40P01",
  "53300",
  "57P01",
  "08006",
]);

export function createLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    formatters: {
      log(object) {
        return sanitizeObject(object);
      },
    },
    redact: {
      censor: redactedValue,
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "authorization",
        "cookie",
        "password",
        "token",
        "apiKey",
        "databaseUrl",
        "*.authorization",
        "*.cookie",
        "*.password",
        "*.token",
        "*.apiKey",
        "*.databaseUrl",
      ],
    },
    serializers: {
      err(error: unknown) {
        return serializeError(error);
      },
      req(request: unknown) {
        const record = asRecord(request);
        const raw = asRecord(record.raw);
        const rawUrl = stringValue(record.url) ?? stringValue(raw.url);

        return {
          id: stringValue(record.id),
          method: stringValue(record.method) ?? stringValue(raw.method),
          path: rawUrl === undefined ? undefined : stripQuery(rawUrl),
        };
      },
      res(response: unknown) {
        const record = asRecord(response);
        const raw = asRecord(record.raw);
        return { statusCode: numberValue(record.statusCode) ?? numberValue(raw.statusCode) };
      },
    },
  };
}

function sanitizeObject(object: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(object, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (typeof value === "string") {
    return stripQuery(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = secretKeyPattern.test(key) ? redactedValue : sanitizeValue(nestedValue, seen);
  }

  return sanitized;
}

function serializeError(error: unknown): Record<string, unknown> {
  // Pino runs the log formatter first, so the error may already be a sanitized record.
  const record = asRecord(error);
  const name = stringValue(record.name);
  const code = stringValue(record.code);
  return {
    code: code && errorCodes.has(code) ? code : undefined,
    name: name && errorNames.has(name) ? name : "UnknownError",
  };
}

function stripQuery(value: string): string {
  // Email/auth protocols may put bearer tokens in path segments as well as queries.
  const authPath = value.split("?")[0]?.split("#")[0];
  if (authPath?.startsWith("/games/") || authPath?.startsWith("/sandbox/games/")) {
    return "/games/[Redacted]";
  }
  if (authPath?.startsWith("/rooms/")) {
    if (
      ["/rooms/creation-operation", "/rooms/invitations/resolve", "/rooms/join"].includes(authPath)
    ) {
      return authPath;
    }
    return "/rooms/[Redacted]";
  }
  if (
    authPath?.startsWith("/credentials/") &&
    !["/credentials/revoke", "/credentials/clear"].includes(authPath)
  ) {
    return "/credentials/[Redacted]";
  }
  if (
    authPath?.startsWith("/api/auth/") &&
    !["/api/auth/get-session", "/api/auth/sign-out"].includes(authPath)
  ) {
    return "/api/auth/[Redacted]";
  }
  if (value.startsWith("/")) {
    return authPath ?? value;
  }

  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (
        url.pathname.startsWith("/api/auth/") ||
        url.pathname.startsWith("/credentials/") ||
        url.pathname.startsWith("/rooms/")
      ) {
        url.pathname = stripQuery(url.pathname);
      }
      url.hash = "";
      url.search = "";
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    // Most log strings are not URLs and should be returned unchanged.
  }

  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
