import type { GameDetails, ModelDiscoveryResult } from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/client";
import { createSessionCredentials } from "../api/session-credentials";
import { deferred, setupModels } from "../test/ai-setup";
import { GAME_ID, snapshot } from "../test/fixtures";

import { type SetupApi, SetupController } from "./controller";
import { parameterErrors, setupConfiguration } from "./state";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
});
const credentialId = "61111111-1111-4111-8111-111111111111";
const saved = {
  credentialId,
  provider: "openai" as const,
  label: "Arena",
  maskedSuffix: "1234",
  createdAt: "2026-10-01T00:00:00.000Z",
};

async function fixture() {
  const lifetime = new AbortController();
  const credentials = createSessionCredentials(lifetime.signal);
  const api = {
    bootstrap: vi.fn<SetupApi["bootstrap"]>().mockResolvedValue(),
    unfinished: vi.fn<SetupApi["unfinished"]>().mockResolvedValue(null),
    discover: vi
      .fn<SetupApi["discover"]>()
      .mockImplementation(async ({ provider }) => ({ ok: true, models: setupModels(provider) })),
    create: vi
      .fn<SetupApi["create"]>()
      .mockImplementation(async (configuration) => ({ snapshot: snapshot(), configuration })),
  };
  const controller = new SetupController(api, credentials);
  const disconnect = controller.connect();
  cleanup.push(() => {
    disconnect();
    lifetime.abort();
  });
  await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("editing"));
  async function ready() {
    for (const color of ["white", "black"] as const) {
      controller.setKey(color, `${color}-sentinel-key`);
      await controller.discover(color);
      controller.setModel(color, "fixture/model-a");
    }
  }
  return { api, credentials, controller, disconnect, ready, lifetime };
}

describe("independent AI setup", () => {
  it("aborts discovery immediately when its credential owner ends before screen unmount", async () => {
    const { controller, api, credentials, lifetime } = await fixture();
    controller.setKey("white", "white-sentinel-key");
    const pending = deferred<ModelDiscoveryResult>();
    api.discover.mockReturnValue(pending.promise);
    const discovering = controller.discover("white");
    await vi.waitFor(() => expect(api.discover).toHaveBeenCalledOnce());
    lifetime.abort();
    expect(api.discover.mock.calls[0]![1].aborted).toBe(true);
    const stopped = controller.getSnapshot();
    pending.resolve({ ok: true, models: setupModels("openai") });
    await discovering;
    expect(controller.getSnapshot()).toBe(stopped);
    expect(stopped.seats.white.models).toEqual([]);
    expect(() => credentials.require("white", "openai")).toThrow();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("selects saved references per seat, cancels obsolete discovery and invalidates removed selections", async () => {
    const { controller, api, credentials } = await fixture();
    controller.updateSavedCredentials([saved]);
    controller.setCredential("white", credentialId);
    const old = deferred<ModelDiscoveryResult>();
    api.discover.mockReturnValueOnce(old.promise);
    const pending = controller.discover("white");
    await vi.waitFor(() => expect(api.discover).toHaveBeenCalledOnce());
    expect(api.discover.mock.calls[0]?.[0]).toEqual({ provider: "openai", credentialId });
    controller.setCredential("white", "session");
    expect(api.discover.mock.calls[0]?.[1].aborted).toBe(true);
    old.resolve({ ok: true, models: setupModels("openai") });
    await pending;
    expect(controller.getSnapshot().seats.white.models).toEqual([]);
    controller.setCredential("white", credentialId);
    await controller.discover("white");
    controller.setModel("white", "fixture/model-a");
    controller.setKey("black", "black-raw-key");
    await controller.discover("black");
    controller.setModel("black", "fixture/model-a");
    expect(setupConfiguration(controller.getSnapshot())).not.toBeNull();
    controller.updateSavedCredentials([]);
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
    expect(() => credentials.require("white", "openai")).toThrow();
    expect(credentials.require("black", "openai")).toEqual({ apiKey: "black-raw-key" });
  });
  it("invalidates a selection removed during creation before editing can start another game", async () => {
    const { controller, api, credentials } = await fixture();
    controller.updateSavedCredentials([saved]);
    controller.setCredential("white", credentialId);
    await controller.discover("white");
    controller.setModel("white", "fixture/model-a");
    controller.setKey("black", "black-raw-key");
    await controller.discover("black");
    controller.setModel("black", "fixture/model-a");
    const creation = deferred<GameDetails>();
    api.create.mockReturnValueOnce(creation.promise);
    const starting = controller.start();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    controller.updateSavedCredentials([]);
    creation.reject(new ApiFailure("network"));
    expect(await starting).toBeNull();
    expect(controller.getSnapshot().issue?.code).toBe("creation_uncertain");
    await controller.checkExisting();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "editing",
      seats: {
        white: { credential: "session", keyReady: false, issue: { code: "provider_auth" } },
        black: { modelId: "fixture/model-a" },
      },
    });
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
    expect(() => credentials.require("white", "openai")).toThrow();
    expect(credentials.require("black", "openai")).toEqual({ apiKey: "black-raw-key" });
    expect(await controller.start()).toBeNull();
    expect(api.create).toHaveBeenCalledOnce();
  });
  it.each(["white", "black"] as const)(
    "creates a %s human with only the opponent's key",
    async (humanColor) => {
      const { controller, api, credentials, ready } = await fixture();
      await ready();
      controller.setHumanColor(humanColor);
      controller.setMode("ai_vs_human");
      expect(() => credentials.require(humanColor, "openai")).toThrow();
      controller.setKey(humanColor, "ignored-key");
      await controller.discover(humanColor);
      expect(api.discover).toHaveBeenCalledTimes(2);
      const game = await controller.start();
      expect(game?.configuration).toMatchObject({
        mode: "ai_vs_human",
        seats: {
          [humanColor]: { type: "human" },
          [humanColor === "white" ? "black" : "white"]: { type: "ai" },
        },
      });
      expect(JSON.stringify(api.create.mock.calls)).not.toContain("sentinel-key");
    },
  );

  it("cancels stale discovery when a seat becomes human and requires fresh AI configuration when switched back", async () => {
    const { controller, api, credentials, ready } = await fixture();
    await ready();
    const old = deferred<ModelDiscoveryResult>();
    api.discover.mockReturnValueOnce(old.promise);
    const pending = controller.discover("white");
    await vi.waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
    controller.setMode("ai_vs_human");
    expect(api.discover.mock.calls[2]?.[1].aborted).toBe(true);
    old.resolve({ ok: true, models: setupModels("openai") });
    await pending;
    expect(controller.getSnapshot().seats.white.models).toEqual([]);
    controller.setHumanColor("black");
    expect(() => credentials.require("black", "openai")).toThrow();
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
    controller.setMode("ai_vs_ai");
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
  });

  it("defaults both seats to OpenAI, then creates identical models with independent settings and keys", async () => {
    const { controller, api, credentials, ready, disconnect } = await fixture();
    expect(api.bootstrap).not.toHaveBeenCalled();
    expect(api.discover).not.toHaveBeenCalled();
    expect(controller.getSnapshot().seats).toMatchObject({
      white: { provider: "openai" },
      black: { provider: "openai" },
    });
    await ready();
    controller.setParameter("white", "temperature", "0.2");
    controller.setParameter("black", "reasoningEffort", "high");
    const game = await controller.start();
    expect(game?.configuration?.seats).toMatchObject({
      white: { provider: "openai", modelId: "fixture/model-a", parameters: { temperature: 0.2 } },
      black: {
        provider: "openai",
        modelId: "fixture/model-a",
        parameters: { reasoningEffort: "high" },
      },
    });
    expect(
      api.discover.mock.calls.map(([input]) => ("apiKey" in input ? input.apiKey : undefined)),
    ).toEqual(["white-sentinel-key", "black-sentinel-key"]);
    expect(
      JSON.stringify({ state: controller.getSnapshot(), game, creation: api.create.mock.calls }),
    ).not.toContain("sentinel-key");
    disconnect();
    expect(credentials.require("white", "openai")).toEqual({ apiKey: "white-sentinel-key" });
  });

  it("shares only bootstrap between simultaneous discoveries and suppresses duplicate clicks", async () => {
    const { controller, api } = await fixture();
    const bootstrap = deferred<void>();
    api.bootstrap.mockReturnValue(bootstrap.promise);
    controller.setKey("white", "white-key");
    controller.setKey("black", "black-key");
    const white = controller.discover("white");
    const black = controller.discover("black");
    await controller.discover("white");
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    bootstrap.resolve();
    await Promise.all([white, black]);
    expect(api.discover).toHaveBeenCalledTimes(2);
  });

  it.each(["provider", "key"])(
    "discards stale discovery after a %s change, even if transport ignores cancellation",
    async (change) => {
      const { controller, api, credentials, ready } = await fixture();
      await ready();
      const old = deferred<ModelDiscoveryResult>();
      api.discover.mockReturnValueOnce(old.promise);
      const request = controller.discover("white");
      await vi.waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
      if (change === "provider") controller.setProvider("white", "google");
      else controller.setKey("white", "replacement-key");
      expect(api.discover.mock.calls[2]?.[1].aborted).toBe(true);
      expect(controller.getSnapshot().seats.white.modelId).toBe("");
      expect(controller.getSnapshot().seats.black.modelId).toBe("fixture/model-a");
      old.resolve({ ok: true, models: setupModels("openai") });
      await request;
      expect(controller.getSnapshot().seats.white.models).toEqual([]);
      if (change === "provider") expect(() => credentials.require("white", "openai")).toThrow();
      else expect(credentials.require("white", "openai")).toEqual({ apiKey: "replacement-key" });
    },
  );

  it("reconciles capabilities and model changes, validates bounds, and omits unknown controls", async () => {
    const { controller, api, ready } = await fixture();
    await ready();
    controller.setParameter("white", "maxOutputTokens", "15");
    expect(parameterErrors(controller.getSnapshot().seats.white)).toEqual(["maxOutputTokens"]);
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
    controller.setParameter("white", "maxOutputTokens", "16.5");
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
    controller.setParameter("white", "maxOutputTokens", "16");
    expect(setupConfiguration(controller.getSnapshot())).not.toBeNull();
    for (const draft of ["1e", "0x10", " ", "Infinity"]) {
      controller.setParameter("white", "temperature", draft);
      expect(setupConfiguration(controller.getSnapshot())).toBeNull();
    }
    controller.setParameter("white", "temperature", "");
    controller.setModel("white", "fixture/unsupported");
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
    controller.setModel("white", "fixture/unknown");
    controller.setParameter("white", "temperature", "1");
    expect(setupConfiguration(controller.getSnapshot())?.seats.white).toMatchObject({
      parameters: {},
    });
    const changed = setupModels("openai");
    changed[0]!.capabilities.parameters.temperature = null;
    api.discover.mockResolvedValueOnce({ ok: true, models: changed });
    await controller.discover("white");
    expect(controller.getSnapshot().seats.white.modelId).toBe("");
    controller.setModel("white", "fixture/model-a");
    expect(setupConfiguration(controller.getSnapshot())?.seats.white).toMatchObject({
      parameters: {},
    });
  });

  it("treats empty, rejected-key and unavailable discovery as not ready and allows explicit retry", async () => {
    const { controller, api } = await fixture();
    controller.setKey("white", "bad key");
    await controller.discover("white");
    expect(api.discover).not.toHaveBeenCalled();
    expect(controller.getSnapshot().seats.white.issue?.code).toBe("key_format");
    controller.setKey("white", "valid-format");
    api.discover.mockResolvedValueOnce({ ok: false, error: { code: "provider_auth" } });
    await controller.discover("white");
    expect(controller.getSnapshot().seats.white.issue?.code).toBe("provider_auth");
    api.discover.mockResolvedValueOnce({ ok: true, models: [] });
    await controller.discover("white");
    expect(controller.getSnapshot().seats.white.discovery).toBe("loaded");
    api.discover.mockRejectedValueOnce(new Error("raw-key-do-not-render"));
    await controller.discover("white");
    expect(controller.getSnapshot().seats.white.issue?.code).toBe("unavailable");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("raw-key");
    expect(setupConfiguration(controller.getSnapshot())).toBeNull();
  });

  it("never adopts a catalog belonging to a different provider", async () => {
    const { controller, api } = await fixture();
    controller.setKey("white", "white-key");
    api.discover.mockResolvedValueOnce({ ok: true, models: setupModels("google") });
    await controller.discover("white");
    expect(controller.getSnapshot().seats.white.discovery).toBe("error");
    expect(controller.getSnapshot().seats.white.models).toEqual([]);
  });

  it("synchronously gates creation and ignores edits or duplicate Start during its handoff", async () => {
    const { controller, api, ready } = await fixture();
    expect(await controller.start()).toBeNull();
    await ready();
    const pending = deferred<GameDetails>();
    api.create.mockReturnValueOnce(pending.promise);
    const start = controller.start();
    expect(await controller.start()).toBeNull();
    controller.setProvider("white", "google");
    expect(controller.getSnapshot().seats.white.provider).toBe("openai");
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    pending.resolve({
      snapshot: snapshot(),
      configuration: setupConfiguration(controller.getSnapshot()),
    });
    expect(await start).not.toBeNull();
    expect(await controller.start()).toBeNull();
  });

  it.each(["existing", "create-conflict"])(
    "handles %s, including Sandbox, without a game mutation",
    async (kind) => {
      const { controller, api, ready } = await fixture();
      if (kind === "existing") {
        api.unfinished.mockResolvedValueOnce({ snapshot: snapshot(), configuration: null });
        await controller.checkExisting();
      } else {
        await ready();
        api.create.mockRejectedValueOnce(new ApiFailure("api", "GAME_CONFLICT", snapshot()));
        await controller.start();
      }
      expect(controller.getSnapshot()).toMatchObject({
        phase: "conflict",
        existingGameId: GAME_ID,
      });
      expect(await controller.start()).toBeNull();
    },
  );

  it("requires an explicit check after uncertain creation, never automatically retries", async () => {
    const { controller, api, ready } = await fixture();
    await ready();
    api.create.mockRejectedValueOnce(new ApiFailure("network"));
    await controller.start();
    expect(controller.getSnapshot().issue?.code).toBe("creation_uncertain");
    expect(await controller.start()).toBeNull();
    api.unfinished.mockResolvedValueOnce({ snapshot: snapshot(), configuration: null });
    await controller.checkExisting();
    expect(controller.getSnapshot().phase).toBe("conflict");
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("drops a late creation handoff after unmount and reads the existing game on reconnect", async () => {
    const { controller, api, ready, disconnect, credentials } = await fixture();
    await ready();
    const configuration = setupConfiguration(controller.getSnapshot());
    const pending = deferred<GameDetails>();
    api.create.mockReturnValueOnce(pending.promise);
    const starting = controller.start();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    disconnect();
    expect(api.create.mock.calls[0]?.[1].aborted).toBe(true);
    pending.resolve({ snapshot: snapshot(), configuration });
    expect(await starting).toBeNull();
    expect(() => credentials.require("white", "openai")).toThrow();
    api.unfinished.mockResolvedValueOnce({ snapshot: snapshot(), configuration });
    const reconnect = controller.connect();
    cleanup.push(reconnect);
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("conflict"));
  });

  it.each(["pagehide", "disconnect", "access"])(
    "clears credentials and late discovery on %s",
    async (cause) => {
      const { controller, api, credentials, ready, disconnect } = await fixture();
      await ready();
      const pending = deferred<ModelDiscoveryResult>();
      api.discover.mockReturnValueOnce(pending.promise);
      const discovering = controller.discover("white");
      await vi.waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
      if (cause === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else if (cause === "disconnect") disconnect();
      else pending.reject(new ApiFailure("api", "UNAUTHORIZED"));
      if (cause !== "access") pending.resolve({ ok: true, models: setupModels("openai") });
      await discovering;
      expect(() => credentials.require("white", "openai")).toThrow();
      expect(() => credentials.require("black", "openai")).toThrow();
      expect(controller.getSnapshot().seats.white.models).toEqual([]);
    },
  );
});
