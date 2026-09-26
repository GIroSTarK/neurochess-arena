import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  type AiProvider,
  credentialMetadataSchema,
  gameDetailsSchema,
  gameInvocationsSchema,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import {
  aiControllers,
  aiTurns,
  authSchema,
  createCredentialRepository,
  gameCommands,
  gameParticipants,
  games,
  modelInvocations,
  moves,
  providerCredentials,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCredentialCipher } from "../src/credentials/encryption.js";
import { createCredentialService } from "../src/credentials/service.js";
import { createGameService } from "../src/games/service.js";
import { createLoggerOptions } from "../src/logger.js";

import { AccountGameHarness, get, post } from "./account-game-helpers.js";
import { turnCommand } from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";
import { type AdapterContractFixture, PROVIDER_KEY } from "./providers/adapter-contract.js";
import { anthropicFixture } from "./providers/anthropic-fixtures.js";
import { googleFixture } from "./providers/google-fixtures.js";
import { type HttpStep, mockHttp } from "./providers/mock-http.js";
import { openAiCatalog, openAiFixture } from "./providers/openai-fixtures.js";
import { openRouterFixture } from "./providers/openrouter-fixtures.js";

const harness = new AccountGameHarness();
const encryption = {
  activeKeyId: "fixture",
  keys: { fixture: Buffer.alloc(32, 31).toString("base64") },
};
const cipher = createCredentialCipher(encryption);
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

async function setup(
  wire: AdapterContractFixture,
  steps: readonly HttpStep[],
  options: Parameters<AccountGameHarness["createApi"]>[0] = {},
) {
  const http = mockHttp(steps);
  const logs: string[] = [];
  const api = await harness.createApi({
    credentialCipher: cipher,
    credentials: (db) => createCredentialService(createCredentialRepository(db), cipher),
    aiAdapters: { [wire.provider]: wire.createAdapter(http.transport) },
    logger: {
      ...createLoggerOptions("info"),
      stream: { write: (chunk: string) => logs.push(chunk) },
    },
    ...options,
  });
  const owner = await harness.account(api);
  const saved = await save(api, owner.cookie, wire.provider);
  return { api, owner, saved, http, logs };
}

async function save(api: TestApi, cookie: string, provider: AiProvider) {
  const response = await post(api, cookie, "/api/credentials", {
    save: true,
    provider,
    label: "Test credential",
    apiKey: PROVIDER_KEY,
  });
  expect(response.statusCode).toBe(201);
  return credentialMetadataSchema.parse(response.json());
}

async function start(api: TestApi, cookie: string, wire = openAiFixture, human = false) {
  const seat = { type: "ai", provider: wire.provider, modelId: wire.modelId, parameters: {} };
  const created = await post(api, cookie, "/games", {
    mode: human ? "ai_vs_human" : "ai_vs_ai",
    seats: { white: seat, black: human ? { type: "human" } : seat },
  });
  expect(created.statusCode, created.body).toBe(201);
  const snapshot = gameDetailsSchema.parse(created.json()).snapshot;
  expect(
    (
      await post(api, cookie, `/games/${snapshot.gameId}/controller`, {
        gameId: snapshot.gameId,
        controllerId: snapshot.gameId,
        action: "acquire",
        expectedVersion: snapshot.version,
      })
    ).statusCode,
  ).toBe(200);
  return snapshot;
}

const turn = (api: TestApi, cookie: string, snapshot: GameSnapshot, credentialId: string) =>
  post(api, cookie, `/games/${snapshot.gameId}/ai-turn`, {
    ...turnCommand(snapshot),
    credentialId,
  });
const catalog = () => openAiFixture.catalog([openAiFixture.modelId]);
async function attempts(api: TestApi, cookie: string, gameId: string) {
  return gameInvocationsSchema.parse(
    (await get(api, cookie, `/games/${gameId}/invocations`)).json(),
  ).turns;
}

describe("saved credentials in provider operations", () => {
  it("does not decrypt after cancellation during credential lookup", async () => {
    const controller = new AbortController();
    const { api, owner, saved, http } = await setup(openAiFixture, [], {
      repository: (original) => ({
        ...original,
        write: (run) =>
          original.write((tx) =>
            run({
              ...tx,
              getProviderCredential: async (...args) => {
                const record = await tx.getProviderCredential(...args);
                controller.abort();
                return record;
              },
            }),
          ),
      }),
    });
    const decrypt = vi.spyOn(cipher, "decrypt");
    const service = createGameService(api.repository, {
      nodeEnv: "test",
      sandboxEnabled: false,
      credentialCipher: cipher,
      aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
    });
    expect(
      await service.models(owner.principal, "openai", {
        credentialId: saved.credentialId,
        signal: controller.signal,
      }),
    ).toEqual({
      ok: false,
      error: { code: "provider_unavailable", reason: "cancelled" },
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
  });
  it.each([openAiFixture, anthropicFixture, googleFixture, openRouterFixture])(
    "$provider resolves saved discovery and turns, preserves session keys and redacts persisted output",
    async (wire) => {
      const catalog = () => wire.catalog([wire.modelId]);
      const { api, owner, saved, http, logs } = await setup(wire, [
        ...catalog(),
        ...catalog(),
        wire.completion(JSON.stringify({ move: "e2e4", commentary: PROVIDER_KEY })),
        ...catalog(),
        wire.completion('{"move":"e7e5"}'),
      ]);
      const discovery = await post(api, owner.cookie, "/providers/models", {
        provider: wire.provider,
        credentialId: saved.credentialId,
      });
      expect(discovery.statusCode).toBe(200);
      expect(discovery.json()).toMatchObject({ ok: true, models: [{ id: wire.modelId }] });
      const initial = await start(api, owner.cookie, wire);
      const command = { ...turnCommand(initial), credentialId: saved.credentialId };
      const response = await post(api, owner.cookie, `/games/${initial.gameId}/ai-turn`, command);
      expect(response.statusCode, response.body).toBe(200);
      const white = gameSnapshotSchema.parse(response.json());
      expect(white.moves.map((move) => move.uci)).toEqual(["e2e4"]);
      const count = http.requests.length;
      expect(
        (await post(api, owner.cookie, `/games/${initial.gameId}/ai-turn`, command)).statusCode,
      ).toBe(409);
      expect(http.requests).toHaveLength(count);
      const black = await post(api, owner.cookie, `/games/${initial.gameId}/ai-turn`, {
        ...turnCommand(white),
        apiKey: PROVIDER_KEY,
      });
      expect(black.statusCode).toBe(200);
      expect(gameSnapshotSchema.parse(black.json()).moves).toHaveLength(2);
      expect(http.requests).toHaveLength(catalog().length * 3 + 2);
      for (const request of http.requests) {
        expect(wire.credential(request)).toBe(
          wire.provider === "openai" || wire.provider === "openrouter"
            ? `Bearer ${PROVIDER_KEY}`
            : PROVIDER_KEY,
        );
      }
      const invocations = await attempts(api, owner.cookie, initial.gameId);
      expect(invocations[0]!.attempts[0]).toMatchObject({ outcome: "accepted", commentary: null });
      const stored = await Promise.all([
        api.database.db.select().from(games).where(eq(games.id, initial.gameId)),
        api.database.db
          .select()
          .from(gameParticipants)
          .where(eq(gameParticipants.gameId, initial.gameId)),
        api.database.db.select().from(gameCommands).where(eq(gameCommands.gameId, initial.gameId)),
        api.database.db.select().from(moves).where(eq(moves.gameId, initial.gameId)),
        api.database.db
          .select()
          .from(modelInvocations)
          .where(eq(modelInvocations.turnId, invocations[0]!.id)),
      ]);
      const exposed = JSON.stringify([
        stored,
        invocations,
        discovery.json(),
        response.json(),
        black.json(),
        logs,
      ]);
      expect(exposed).not.toContain(PROVIDER_KEY);
      expect(exposed).not.toContain(saved.credentialId);
    },
  );

  it("denies guests and rejects foreign, missing and mismatched credentials before decryption", async () => {
    const { api, owner, saved, http } = await setup(openAiFixture, []);
    const stranger = await harness.account(api);
    const guest = await harness.guest(api);
    const decrypt = vi.spyOn(cipher, "decrypt");
    const source = { provider: "openai", credentialId: saved.credentialId };
    expect((await post(api, guest.cookie, "/providers/models", source)).statusCode).toBe(403);
    for (const [cookie, input] of [
      [stranger.cookie, source],
      [owner.cookie, { ...source, credentialId: randomUUID() }],
      [owner.cookie, { ...source, provider: "google" }],
    ] as const) {
      const response = await post(api, cookie, "/providers/models", input);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: false, error: { code: "provider_auth" } });
    }
    const initial = await start(api, owner.cookie);
    expect((await turn(api, stranger.cookie, initial, saved.credentialId)).statusCode).toBe(404);
    const foreign = await save(api, stranger.cookie, "openai");
    const paused = await turn(api, owner.cookie, initial, foreign.credentialId);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ state: "paused", result: "*", moves: [] });
    expect((await attempts(api, owner.cookie, initial.gameId))[0]!.attempts).toMatchObject([
      { error: { code: "provider_auth" }, outcome: "provider_error" },
    ]);
    expect(decrypt).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
  });

  it.each(["revoked", "wrong-provider", "tampered", "unknown-key", "missing-keyring"] as const)(
    "%s pauses before discovery without a technical loss",
    async (scenario) => {
      const { api, owner, saved, http, logs } = await setup(openAiFixture, []);
      const initial = await start(api, owner.cookie);
      let target = api;
      let credentialId = saved.credentialId;
      if (scenario === "revoked") {
        expect(
          (await post(api, owner.cookie, `/api/credentials/${credentialId}/revoke`, {})).statusCode,
        ).toBe(200);
      } else if (scenario === "wrong-provider") {
        credentialId = (await save(api, owner.cookie, "google")).credentialId;
      } else if (scenario === "missing-keyring") {
        target = await harness.createApi({
          aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
        });
      } else {
        await api.database.db
          .update(providerCredentials)
          .set(scenario === "tampered" ? { authTag: "00".repeat(16) } : { keyId: "lost" })
          .where(eq(providerCredentials.id, credentialId));
      }
      const response = await turn(target, owner.cookie, initial, credentialId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: "paused", moves: [], result: "*" });
      const turns = await attempts(api, owner.cookie, initial.gameId);
      expect(turns[0]!.attempts).toMatchObject([
        { outcome: "provider_error", error: { code: "provider_auth" }, usage: null },
      ]);
      expect(
        (await api.database.db.select().from(aiTurns).where(eq(aiTurns.gameId, initial.gameId)))[0]!
          .invalidOutputCount,
      ).toBe(0);
      expect(http.requests).toHaveLength(0);
      expect(JSON.stringify([logs, response.json(), turns])).not.toContain(PROVIDER_KEY);
    },
  );

  it.each(["discovery", "invalid-retry"] as const)(
    "rechecks revocation after %s before another dispatch",
    async (stage) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<Response>();
      const held: HttpStep = () => {
        entered.resolve();
        return release.promise;
      };
      const { api, owner, saved, http } = await setup(
        openAiFixture,
        stage === "discovery" ? [held] : [...catalog(), held],
      );
      const initial = await start(api, owner.cookie);
      const pending = turn(api, owner.cookie, initial, saved.credentialId);
      void pending.then(() => entered.resolve());
      await entered.promise;
      try {
        expect(
          (await post(api, owner.cookie, `/api/credentials/${saved.credentialId}/revoke`, {}))
            .statusCode,
        ).toBe(200);
      } finally {
        release.resolve(
          stage === "discovery"
            ? Response.json(openAiCatalog([openAiFixture.modelId]))
            : openAiFixture.completion('{"move":"e2e5"}'),
        );
      }
      const response = await pending;
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ state: "paused", moves: [], result: "*" });
      const turns = await attempts(api, owner.cookie, initial.gameId);
      expect(turns[0]!.attempts.at(-1)).toMatchObject({
        outcome: "provider_error",
        error: { code: "provider_auth" },
        usage: null,
      });
      expect(turns[0]!.attempts).toHaveLength(stage === "discovery" ? 1 : 2);
      expect(
        (await api.database.db.select().from(aiTurns).where(eq(aiTurns.gameId, initial.gameId)))[0]!
          .invalidOutputCount,
      ).toBe(stage === "discovery" ? 0 : 1);
      expect(http.requests).toHaveLength(stage === "discovery" ? 1 : catalog().length + 1);
    },
  );

  it.each(["revocation", "pause", "session-loss"] as const)(
    "fences late results according to %s and deduplicates in-flight commands",
    async (action) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<Response>();
      const { api, owner, saved, http } = await setup(openAiFixture, [
        ...catalog(),
        () => {
          entered.resolve();
          return release.promise;
        },
      ]);
      const initial = await start(api, owner.cookie, openAiFixture, true);
      const command = { ...turnCommand(initial), credentialId: saved.credentialId };
      const pending = post(api, owner.cookie, `/games/${initial.gameId}/ai-turn`, command);
      void pending.then(() => entered.resolve());
      await entered.promise;
      try {
        const duplicate = await post(
          api,
          owner.cookie,
          `/games/${initial.gameId}/ai-turn`,
          command,
        );
        expect(duplicate.statusCode).toBe(409);
        if (action === "revocation") {
          expect(
            (await post(api, owner.cookie, "/api/credentials/clear", { confirm: true })).statusCode,
          ).toBe(200);
        } else if (action === "pause") {
          expect(
            (
              await post(api, owner.cookie, `/games/${initial.gameId}/lifecycle`, {
                gameId: initial.gameId,
                expectedVersion: initial.version,
                commandId: randomUUID(),
                action: "pause",
              })
            ).statusCode,
          ).toBe(200);
        } else {
          await api.database.db
            .delete(authSchema.session)
            .where(eq(authSchema.session.id, owner.principal.sessionId));
        }
      } finally {
        release.resolve(openAiFixture.completion('{"move":"e2e4"}'));
      }
      const response = await pending;
      expect(response.statusCode, response.body).toBe(
        action === "revocation" ? 200 : action === "pause" ? 409 : 401,
      );
      const [game] = await api.database.db.select().from(games).where(eq(games.id, initial.gameId));
      expect(game!.version).toBe(action === "session-loss" ? initial.version : initial.version + 1);
      expect(
        await api.database.db.select().from(moves).where(eq(moves.gameId, initial.gameId)),
      ).toHaveLength(action === "revocation" ? 1 : 0);
      expect(http.requests).toHaveLength(catalog().length + 1);
    },
  );

  it.each([openAiFixture, anthropicFixture, googleFixture, openRouterFixture])(
    "$provider key rejection pauses without consuming invalid budget",
    async (wire) => {
      const { api, owner, saved, http, logs } = await setup(wire, [
        ...wire.catalog([wire.modelId]),
        wire.failure("authentication"),
      ]);
      const initial = await start(api, owner.cookie, wire);
      const response = await turn(api, owner.cookie, initial, saved.credentialId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: "paused", moves: [], result: "*" });
      expect((await attempts(api, owner.cookie, initial.gameId))[0]!.attempts).toMatchObject([
        { error: { code: "provider_auth" }, outcome: "provider_error" },
      ]);
      expect(http.requests).toHaveLength(wire.catalog([wire.modelId]).length + 1);
      expect(JSON.stringify(logs)).not.toContain(PROVIDER_KEY);
    },
  );

  it("rejects ambiguous HTTP sources, invalid identities, origins and unauthorized seats before decrypting", async () => {
    const { api, owner, saved, http } = await setup(openAiFixture, [
      ...catalog(),
      openAiFixture.completion('{"move":"e2e4"}'),
    ]);
    const initial = await start(api, owner.cookie, openAiFixture, true);
    const decrypt = vi.spyOn(cipher, "decrypt");
    const discovery = { provider: "openai", credentialId: saved.credentialId };
    const command = { ...turnCommand(initial), credentialId: saved.credentialId };
    for (const [url, payload] of [
      ["/providers/models", discovery],
      [`/games/${initial.gameId}/ai-turn`, command],
    ] as const) {
      expect(
        (await post(api, owner.cookie, url, { ...payload, apiKey: PROVIDER_KEY })).statusCode,
      ).toBe(400);
      expect(
        (await post(api, "", url, payload, { "x-neurochess-identity": "account" })).statusCode,
      ).toBe(401);
      expect(
        (await post(api, owner.cookie, url, payload, { origin: "https://untrusted.example" }))
          .statusCode,
      ).toBe(403);
    }
    expect(
      (
        await post(api, owner.cookie, `/games/${initial.gameId}/ai-turn`, {
          ...command,
          controllerId: randomUUID(),
        })
      ).statusCode,
    ).toBe(409);
    expect(decrypt).not.toHaveBeenCalled();
    const played = await turn(api, owner.cookie, initial, saved.credentialId);
    expect(played.statusCode).toBe(200);
    decrypt.mockClear();
    expect(
      (await turn(api, owner.cookie, gameSnapshotSchema.parse(played.json()), saved.credentialId))
        .statusCode,
    ).toBe(403);
    expect(decrypt).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(catalog().length + 1);
  });

  it("rechecks natural session expiry after a credential SQL wait before decrypting", async () => {
    let lookedUp = false;
    const { api, owner, saved, http } = await setup(openAiFixture, [], {
      repository: (original) => ({
        ...original,
        write: (run) =>
          original.write((tx) =>
            run({
              ...tx,
              getProviderCredential: async (...args) => {
                lookedUp = true;
                await delay(1100);
                return tx.getProviderCredential(...args);
              },
            }),
          ),
      }),
    });
    await api.database.db
      .update(authSchema.session)
      .set({ expiresAt: new Date(Date.now() + 1000) })
      .where(eq(authSchema.session.id, owner.principal.sessionId));
    const decrypt = vi.spyOn(cipher, "decrypt");
    const response = await post(api, owner.cookie, "/providers/models", {
      provider: "openai",
      credentialId: saved.credentialId,
    });
    expect(lookedUp).toBe(true);
    expect(response.statusCode).toBe(401);
    expect(decrypt).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
  });

  it("recovery with a saved key still needs a controller and an explicit paused step", async () => {
    const { api, owner, saved, http } = await setup(openAiFixture, [
      ...catalog(),
      openAiFixture.completion('{"move":"e2e4"}'),
    ]);
    const initial = await start(api, owner.cookie);
    const other = await harness.anotherSession(api, owner);
    expect((await get(api, other.cookie, `/games/${initial.gameId}/details`)).statusCode).toBe(200);
    expect(http.requests).toHaveLength(0);
    const recovered = await post(api, other.cookie, `/games/${initial.gameId}/lifecycle`, {
      gameId: initial.gameId,
      commandId: randomUUID(),
      expectedVersion: initial.version,
      action: "pause",
    });
    const paused = gameSnapshotSchema.parse(recovered.json());
    expect(paused.state).toBe("paused");
    expect((await turn(api, other.cookie, paused, saved.credentialId)).statusCode).toBe(409);
    expect(http.requests).toHaveLength(0);
    expect(
      (
        await post(api, other.cookie, `/games/${initial.gameId}/controller`, {
          gameId: initial.gameId,
          controllerId: initial.gameId,
          action: "acquire",
          expectedVersion: paused.version,
        })
      ).statusCode,
    ).toBe(200);
    const result = await post(api, other.cookie, `/games/${initial.gameId}/ai-turn`, {
      ...turnCommand(paused),
      step: true,
      credentialId: saved.credentialId,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: "paused", moves: [{ uci: "e2e4" }] });
  });

  it.each([false, true])(
    "retains the three-invalid-output budget with a saved key (third valid: %s)",
    async (valid) => {
      const { api, owner, saved, http } = await setup(openAiFixture, [
        ...catalog(),
        openAiFixture.completion('{"move":"e2e5"}'),
        openAiFixture.completion('{"move":"e2e5"}'),
        openAiFixture.completion(valid ? '{"move":"e2e4"}' : '{"move":"e2e5"}'),
      ]);
      const initial = await start(api, owner.cookie);
      const result = await turn(api, owner.cookie, initial, saved.credentialId);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject(
        valid
          ? { state: "active", moves: [{ uci: "e2e4" }] }
          : {
              state: "completed",
              terminationReason: "model_technical_loss",
              result: "0-1",
              moves: [],
            },
      );
      const turns = await attempts(api, owner.cookie, initial.gameId);
      expect(turns[0]!.invalidOutputCount).toBe(valid ? 2 : 3);
      expect(turns[0]!.attempts).toHaveLength(3);
      expect(http.requests).toHaveLength(catalog().length + 3);
    },
  );

  it("preserves cancellation, deadline and controller expiry fences with saved credentials", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    const { api, owner, saved, http } = await setup(openAiFixture, [
      ...catalog(),
      () => {
        entered.resolve();
        return release.promise;
      },
    ]);
    const initial = await start(api, owner.cookie);
    const gamesService = createGameService(api.repository, {
      nodeEnv: "test",
      sandboxEnabled: true,
      credentialCipher: cipher,
      aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
    });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      gamesService.aiTurn(owner.principal, turnCommand(initial), {
        credentialId: saved.credentialId,
        signal: cancelled.signal,
      }),
    ).rejects.toMatchObject({ code: "AI_TURN_CANCELLED" });
    expect(http.requests).toHaveLength(0);
    const controller = new AbortController();
    const pending = gamesService.aiTurn(owner.principal, turnCommand(initial), {
      credentialId: saved.credentialId,
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort(new DOMException("fixture deadline", "TimeoutError"));
    try {
      const paused = await pending;
      expect(paused.state).toBe("paused");
      expect((await attempts(api, owner.cookie, initial.gameId))[0]!.attempts).toMatchObject([
        { error: { code: "provider_timeout" }, outcome: "provider_error" },
      ]);
      await api.database.db
        .update(aiControllers)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(aiControllers.gameId, initial.gameId));
      const decrypt = vi.spyOn(cipher, "decrypt");
      await expect(
        gamesService.aiTurn(
          owner.principal,
          { ...turnCommand(paused), step: true },
          { credentialId: saved.credentialId, signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ code: "AI_CONTROLLER_LOST" });
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      release.resolve(openAiFixture.completion('{"move":"e2e4"}'));
    }
    expect(
      await api.database.db.select().from(moves).where(eq(moves.gameId, initial.gameId)),
    ).toHaveLength(0);
    expect(http.requests).toHaveLength(catalog().length + 1);
  });
});
