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
  error: z.object({
    code: z.number().int().min(100).max(599),
    status: z.string().min(1).max(128),
    details: z.array(z.unknown()).max(32).optional(),
  }),
});
const invalidKeySchema = z.object({
  "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
  domain: z.literal("googleapis.com"),
  reason: z.literal("API_KEY_INVALID"),
});
type GoogleOperation = { modelId: string; body: object } | { pageToken?: string };

function httpFailure(
  status: number,
  generation: boolean,
  error?: z.infer<typeof errorSchema>["error"],
): ProviderFailure {
  if (
    status === 401 ||
    status === 403 ||
    error?.status === "UNAUTHENTICATED" ||
    error?.status === "PERMISSION_DENIED" ||
    error?.details?.some((detail) => invalidKeySchema.safeParse(detail).success)
  ) {
    return { code: "provider_auth" };
  }
  if (status === 429 || error?.status === "RESOURCE_EXHAUSTED") return { code: "provider_quota" };
  if (status === 408 || status === 504 || error?.status === "DEADLINE_EXCEEDED") {
    return { code: "provider_timeout" };
  }
  if (status === 499 || error?.status === "CANCELLED") {
    return { code: "provider_unavailable", reason: "cancelled" };
  }
  if (
    generation &&
    (status === 404 ||
      status === 501 ||
      error?.status === "NOT_FOUND" ||
      error?.status === "UNIMPLEMENTED")
  ) {
    return { code: "provider_unavailable", reason: "unsupported_model" };
  }
  return { code: "provider_unavailable", reason: "upstream" };
}

export async function googleRequest(
  transport: typeof fetch,
  input: ProviderRequestAccess,
  operation: GoogleOperation,
): Promise<ProviderJsonResult> {
  const isAborted = () => input.signal.aborted;
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const denied = await input.beforeDispatch?.();
  if (denied) return { ok: false, error: denied };
  if (isAborted()) return { ok: false, error: cancellationFailure(input.signal) };
  const generation = "modelId" in operation;
  const url = new URL(
    generation
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(operation.modelId)}:generateContent`
      : "https://generativelanguage.googleapis.com/v1beta/models",
  );
  if (!generation) {
    url.searchParams.set("pageSize", "1000");
    if (operation.pageToken !== undefined) url.searchParams.set("pageToken", operation.pageToken);
  }
  let response: Response;
  try {
    // Keys stay in headers; pagination never changes the origin, and calls never retry.
    response = await transport(url, {
      method: generation ? "POST" : "GET",
      headers: { "x-goog-api-key": input.apiKey, "Content-Type": "application/json" },
      ...(generation ? { body: JSON.stringify(operation.body) } : {}),
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
    return { ok: false, error: httpFailure(response.status, generation, error.data?.error) };
  } catch {
    return {
      ok: false,
      error: isAborted()
        ? cancellationFailure(input.signal)
        : response.ok
          ? { code: "provider_unavailable", reason: "invalid_response" }
          : httpFailure(response.status, generation),
    };
  }
}
