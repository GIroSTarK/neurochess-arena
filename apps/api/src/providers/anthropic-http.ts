import type { ProviderFailure } from "@neurochess/contracts";
import { z } from "zod";

import type { ProviderRequestAccess } from "./adapter.js";
import {
  cancellationFailure,
  type ProviderJsonResult,
  readBoundedJson,
  transportFailure,
} from "./transport.js";

const errorSchema = z.object({
  type: z.literal("error"),
  error: z.object({ type: z.string().min(1).max(128) }),
});

function httpFailure(status: number, path: "models" | "messages", type?: string): ProviderFailure {
  if (
    status === 401 ||
    status === 403 ||
    type === "authentication_error" ||
    type === "permission_error"
  ) {
    return { code: "provider_auth" };
  }
  if (status === 402 || status === 429 || type === "billing_error" || type === "rate_limit_error") {
    return { code: "provider_quota" };
  }
  if (status === 408 || status === 504 || type === "timeout_error") {
    return { code: "provider_timeout" };
  }
  if (path === "messages" && (status === 404 || type === "not_found_error")) {
    return { code: "provider_unavailable", reason: "unsupported_model" };
  }
  return { code: "provider_unavailable", reason: "upstream" };
}

export async function anthropicRequest(
  transport: typeof fetch,
  path: "models" | "messages",
  input: ProviderRequestAccess,
  options: { body?: object; afterId?: string } = {},
): Promise<ProviderJsonResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const denied = await input.beforeDispatch?.();
  if (denied) return { ok: false, error: denied };
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const url = new URL(`https://api.anthropic.com/v1/${path}`);
  if (path === "models") {
    url.searchParams.set("limit", "1000");
    if (options.afterId !== undefined) url.searchParams.set("after_id", options.afterId);
  }
  let response: Response;
  try {
    // Pagination is explicit; individual HTTP calls never retry or follow redirects.
    response = await transport(url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: input.signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
  } catch (error: unknown) {
    return { ok: false, error: transportFailure(error, input.signal) };
  }
  try {
    const result = await readBoundedJson(response, input.signal);
    if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
    const error = errorSchema.safeParse(result.ok ? result.value : null);
    if (response.ok && !error.success) return result;
    return { ok: false, error: httpFailure(response.status, path, error.data?.error.type) };
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : response.ok
          ? { code: "provider_unavailable", reason: "invalid_response" }
          : httpFailure(response.status, path),
    };
  }
}
