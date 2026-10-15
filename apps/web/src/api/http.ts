import type { z } from "zod";

import { RequestRateLimitFailure } from "./failures";

export type HttpFailureKind = "network" | "timeout" | "malformed" | "cancelled";

interface HttpErrorAdapter<Payload, Context> {
  readonly schema: z.ZodType<Payload>;
  failure(kind: HttpFailureKind): Error;
  isFailure(error: unknown): error is Error;
  fromResponse(payload: Payload, context: Context | undefined): Error;
}

interface HttpOptions<Payload, Context> {
  readonly baseUrl: string | URL;
  readonly fetch?: typeof fetch;
  readonly errors: HttpErrorAdapter<Payload, Context>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly beforeRequest?: () => Promise<void>;
  readonly afterResponse?: () => Promise<void>;
  readonly timeoutAfterPreparation?: boolean;
}

interface RequestOptions<Context> {
  readonly timeoutMs?: number;
  readonly errorContext?: Context | undefined;
  readonly expectedAccount?: string | undefined;
  readonly acceptStatus?: number;
}

const cooldownScopes = new WeakMap<object, Map<string, number>>();

export function validated<T>(schema: z.ZodType<T>, value: unknown, failure: () => Error): T {
  const result = schema.safeParse(value);
  if (!result.success) throw failure();
  return result.data;
}

function isApiOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === "/"
  );
}

export function apiOrigin(value: string, failure: () => Error): URL {
  if (!isApiOrigin(value)) throw failure();
  return new URL(value);
}

export function createHttpRequest<Payload, Context = never>(
  options: HttpOptions<Payload, Context>,
) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { errors } = options;
  // Route actions recreate clients. Cooldowns belong to their identity lifetime,
  // or to the page's fetch implementation for anonymous/public requests.
  const scope = options.signal ?? options.fetch ?? globalThis.fetch;
  let cooldowns = cooldownScopes.get(scope);
  if (!cooldowns) {
    cooldowns = new Map<string, number>();
    cooldownScopes.set(scope, cooldowns);
    const owned = cooldowns;
    options.signal?.addEventListener("abort", () => owned.clear(), { once: true });
  }
  const waits = cooldowns;

  return async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
    requestOptions: RequestOptions<Context> = {},
  ): Promise<T> {
    const cancelled = () => signal.aborted || Boolean(options.signal?.aborted);
    if (cancelled()) throw errors.failure("cancelled");
    for (const [key, until] of waits) if (until <= Date.now()) waits.delete(key);
    let endpoint: URL;
    try {
      endpoint = new URL(path, options.baseUrl);
    } catch {
      throw errors.failure("malformed");
    }
    const expectation =
      requestOptions.expectedAccount ?? options.headers?.["x-neurochess-expected-account"] ?? "";
    const cooldownKey = JSON.stringify([
      endpoint.origin,
      body === undefined ? "GET" : "POST",
      endpoint.pathname,
      expectation,
    ]);
    const until = waits.get(cooldownKey);
    if (until !== undefined) {
      throw new RequestRateLimitFailure(Math.max(1, Math.ceil((until - Date.now()) / 1000)));
    }
    const abort = new AbortController();
    const aborted = () => abort.signal.aborted;
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    options.signal?.addEventListener("abort", cancel, { once: true });
    const startTimeout = () =>
      setTimeout(cancel, requestOptions.timeoutMs ?? options.timeoutMs ?? 10_000);
    let timer = options.timeoutAfterPreparation ? undefined : startTimeout();
    try {
      if (options.beforeRequest) await options.beforeRequest();
      if (cancelled()) throw errors.failure("cancelled");
      // Credential verification has its own deadlines; its transport budget starts afterwards.
      if (options.timeoutAfterPreparation) timer = startTimeout();
      const response = await fetcher(endpoint, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          ...options.headers,
          ...(requestOptions.expectedAccount
            ? { "x-neurochess-expected-account": requestOptions.expectedAccount }
            : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: abort.signal,
      });
      if (aborted()) throw errors.failure("timeout");
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header && /^\d{1,4}$/.test(header) ? Number(header) : NaN;
        const retryAfter =
          Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : 60;
        const oldest = waits.keys().next().value;
        if (waits.size >= 64 && oldest !== undefined) waits.delete(oldest);
        waits.set(cooldownKey, Date.now() + retryAfter * 1000);
        await response.body?.cancel();
        throw new RequestRateLimitFailure(retryAfter);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw errors.failure("malformed");
      }
      if (aborted()) throw errors.failure("timeout");
      if (!response.ok && response.status !== requestOptions.acceptStatus) {
        throw errors.fromResponse(
          validated(errors.schema, payload, () => errors.failure("malformed")),
          requestOptions.errorContext,
        );
      }
      if (options.afterResponse) await options.afterResponse();
      if (cancelled()) throw errors.failure("cancelled");
      return validated(schema, payload, () => errors.failure("malformed"));
    } catch (error: unknown) {
      if (cancelled()) throw errors.failure("cancelled");
      if (aborted()) throw errors.failure("timeout");
      if (error instanceof RequestRateLimitFailure || errors.isFailure(error)) throw error;
      // Retain neither exception text nor unvalidated server data at the transport boundary.
      throw errors.failure("network");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      options.signal?.removeEventListener("abort", cancel);
    }
  };
}
