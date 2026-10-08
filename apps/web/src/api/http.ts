import type { z } from "zod";

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

  return async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
    requestOptions: RequestOptions<Context> = {},
  ): Promise<T> {
    const cancelled = () => signal.aborted || Boolean(options.signal?.aborted);
    if (cancelled()) throw errors.failure("cancelled");
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
      const response = await fetcher(new URL(path, options.baseUrl), {
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
      if (errors.isFailure(error)) throw error;
      // Retain neither exception text nor unvalidated server data at the transport boundary.
      throw errors.failure("network");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      options.signal?.removeEventListener("abort", cancel);
    }
  };
}
