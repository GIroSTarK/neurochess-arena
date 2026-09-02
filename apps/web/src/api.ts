import { healthResponseSchema } from "@neurochess/contracts";

export async function checkApiHealth(apiBaseUrl: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(new URL("/health", apiBaseUrl), {
    headers: { accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("API health request failed");
  }

  healthResponseSchema.parse(await response.json());
}
