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
  error: z.object({ code: z.string().max(128).nullish(), param: z.string().max(128).nullish() }),
});

export function openAiFailure(
  status: number,
  code?: string | null,
  param?: string | null,
): ProviderFailure {
  if (status === 401 || status === 403 || code === "invalid_api_key") {
    return { code: "provider_auth" };
  }
  if (
    status === 429 ||
    [
      "rate_limit_exceeded",
      "insufficient_quota",
      "credit_balance_exhausted",
      "slow_down",
      "organization_spend_limit_exceeded",
      "project_spend_limit_exceeded",
      "organization_usage_limit_exceeded",
    ].includes(code ?? "")
  ) {
    return { code: "provider_quota" };
  }
  if (status === 408 || status === 504 || code === "request_timeout") {
    return { code: "provider_timeout" };
  }
  if (
    code === "model_not_found" ||
    code === "unsupported_model" ||
    (status === 400 && param === "model")
  ) {
    return { code: "provider_unavailable", reason: "unsupported_model" };
  }
  return { code: "provider_unavailable", reason: "upstream" };
}

export async function openAiRequest(
  transport: typeof fetch,
  path: "models" | "responses",
  input: ProviderRequestAccess,
  body?: object,
): Promise<ProviderJsonResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const denied = await input.beforeDispatch?.();
  if (denied) return { ok: false, error: denied };
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  let response: Response;
  try {
    // One fetch only: no retry/backoff, redirect, credential cache, or SDK state.
    response = await transport(`https://api.openai.com/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: input.signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
  } catch (error: unknown) {
    return {
      ok: false,
      error: transportFailure(error, input.signal),
    };
  }
  try {
    const result = await readBoundedJson(response, input.signal);
    if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
    if (response.ok) return result;
    const error = errorSchema.safeParse(result.ok ? result.value : null);
    return {
      ok: false,
      error: openAiFailure(response.status, error.data?.error.code, error.data?.error.param),
    };
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : response.ok
          ? { code: "provider_unavailable", reason: "invalid_response" }
          : openAiFailure(response.status),
    };
  }
}
