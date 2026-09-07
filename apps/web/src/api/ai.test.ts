import type { CreateAiGameRequest, SessionCredential } from "@neurochess/contracts";
import { describe, expect, it, vi } from "vitest";

import { catalogResponse, models } from "../../../../test/ai-models";
import { errorResponse, jsonResponse, snapshot } from "../test/fixtures";

import { createAiSetupApi } from "./ai";

const credential: SessionCredential = { provider: "openai", apiKey: "fixture-memory-only-key" };
const configuration: CreateAiGameRequest = {
  mode: "ai_vs_ai",
  white: { provider: "openai", modelId: "fixture-full", parameters: { temperature: 0 } },
  black: { provider: "openai", modelId: "fixture-full", parameters: {} },
};
const signal = () => new AbortController().signal;

describe("AI setup transport", () => {
  it("sends credentials only in a no-store, credentialed discovery POST body", async () => {
    const discovered = catalogResponse();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(discovered));
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    expect(await api.discover(credential, signal())).toEqual(discovered);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([
      new URL("http://localhost:3001/ai/models"),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        redirect: "error",
        credentials: "include",
        body: JSON.stringify({ credential }),
        headers: { accept: "application/json", "content-type": "application/json" },
      }),
    ]);
    expect(credential.apiKey).toBe("fixture-memory-only-key");
  });

  it.each([
    { ...catalogResponse(), value: models("anthropic") },
    { ...catalogResponse(), value: [models()[0], models()[0]] },
    {
      ...catalogResponse(),
      value: models().map((model) => ({ ...model, name: credential.apiKey })),
    },
    { ...catalogResponse(), catalogId: "not-a-catalog" },
    { ok: true, value: models() },
    { ok: false, error: { kind: "provider_auth", message: credential.apiKey } },
  ])(
    "rejects invalid or credential-bearing discovery results without retaining diagnostics",
    async (payload) => {
      const api = createAiSetupApi("http://localhost:3001", {
        fetch: vi.fn().mockResolvedValue(jsonResponse(payload)),
      });
      await expect(api.discover(credential, signal())).rejects.toMatchObject({
        kind: "malformed",
        message: "malformed",
      });
    },
  );

  it("sends the previous catalog only for explicit refresh and returns its replacement reference", async () => {
    const previous = catalogResponse();
    const next = catalogResponse();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(next));
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    expect(await api.discover(credential, signal(), previous.catalogId)).toEqual(next);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ credential, catalogId: previous.catalogId }),
    );
  });

  it("rejects keys in configuration before creating a game and sends only validated configuration", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(snapshot(), 201));
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    const unsafe = { ...configuration, credential };
    await expect(api.create(unsafe, signal())).rejects.toMatchObject({ kind: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
    await api.create(configuration, signal());
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(configuration));
  });

  it("does not send malformed keys or duplicate providers through the boundary", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        providers: [
          { id: "openai", name: "OpenAI" },
          { id: "openai", name: "Duplicate" },
        ],
      }),
    );
    const api = createAiSetupApi("http://localhost:3001", { fetch });
    await expect(
      api.discover({ ...credential, apiKey: "has whitespace" }, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.providers(signal())).rejects.toMatchObject({ kind: "malformed" });
  });

  it("preserves authorized creation conflicts and discards server message fields", async () => {
    const api = createAiSetupApi("http://localhost:3001", {
      fetch: vi.fn().mockResolvedValue(errorResponse("GAME_CONFLICT", 409, snapshot())),
    });
    await expect(api.create(configuration, signal())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: snapshot(),
      message: "api",
    });
  });
});
