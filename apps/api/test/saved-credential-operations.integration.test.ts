import { randomUUID } from "node:crypto";

import { type AiProvider, gameInvocationsSchema, gameSnapshotSchema } from "@neurochess/contracts";
import { providerCredentials } from "@neurochess/database";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCredentialCipher } from "../src/credentials/crypto.js";
import { createLoggerOptions } from "../src/logger.js";

import { AccountGameHarness } from "./account-game-helpers.js";
import { control, turnCommand } from "./ai-turn-helpers.js";
import type { TestApi } from "./helpers.js";
import { type AdapterContractFixture, PROVIDER_KEY } from "./providers/adapter-contract.js";
import { anthropicFixture } from "./providers/anthropic-fixtures.js";
import { googleFixture } from "./providers/google-fixtures.js";
import { mockHttp } from "./providers/mock-http.js";
import { openAiFixture } from "./providers/openai-fixtures.js";
import { openRouterFixture } from "./providers/openrouter-fixtures.js";

const fixtures = [openAiFixture, anthropicFixture, googleFixture, openRouterFixture];
const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

async function save(api: TestApi, cookie: string, provider: AiProvider, changes: object = {}) {
  const credentialId = randomUUID();
  const response = await harness.post(api, cookie, "/credentials", {
    credentialId,
    provider,
    apiKey: PROVIDER_KEY,
    label: "Test",
    save: true,
    ...changes,
  });
  expect(response.statusCode, response.body).toBe(201);
  return credentialId;
}

async function start(
  api: TestApi,
  cookie: string,
  fixture: AdapterContractFixture = openAiFixture,
) {
  const seat = {
    type: "ai",
    provider: fixture.provider,
    modelId: fixture.modelId,
    parameters: fixture.parameters,
  };
  const { snapshot } = await harness.createGame(api, cookie, {
    mode: "ai_vs_ai",
    seats: { white: seat, black: seat },
  });
  const claim = await harness.post(api, cookie, `/games/${snapshot.gameId}/controller`, {
    gameId: snapshot.gameId,
    controllerId: snapshot.gameId,
    expectedVersion: snapshot.version,
    action: "acquire",
  });
  expect(claim.statusCode).toBe(200);
  return snapshot;
}

async function invocations(api: TestApi, cookie: string, gameId: string) {
  const response = await api.app.inject({
    url: `/games/${gameId}/invocations`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return gameInvocationsSchema.parse(response.json());
}

describe("saved credentials in authorized provider operations", () => {
  it.each(["discovery", "turn"] as const)(
    "fences a saved-key %s outcome after session revocation",
    async (operation) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const catalog = openAiFixture.catalog([openAiFixture.modelId])[0] as Response;
      const gated = async () => {
        entered.resolve();
        await release.promise;
        return operation === "discovery"
          ? catalog
          : openAiFixture.completion(JSON.stringify({ move: "e2e4" }));
      };
      const http = mockHttp(operation === "discovery" ? [gated] : [catalog, gated]);
      const api = await harness.createAuthenticatedApi({
        aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
      });
      const account = await harness.account(api);
      const credentialId = await save(api, account.cookie, "openai");
      const snapshot = await start(api, account.cookie);
      const pending = harness.post(
        api,
        account.cookie,
        operation === "discovery" ? "/providers/models" : `/games/${snapshot.gameId}/ai-turn`,
        operation === "discovery"
          ? { provider: "openai", credentialId }
          : { ...turnCommand(snapshot), credentialId },
      );
      await entered.promise;
      try {
        expect((await harness.post(api, account.cookie, "/api/auth/sign-out", {})).statusCode).toBe(
          200,
        );
      } finally {
        release.resolve();
      }
      expect((await pending).statusCode).toBe(401);
      const stored = await api.repository.read((reader) => reader.getMoves(snapshot.gameId));
      expect(stored).toHaveLength(0);
    },
  );
  it.each(fixtures)(
    "uses $provider through discovery, invalid retry and legal acceptance without exposing the saved key",
    async (fixture) => {
      const logs: string[] = [];
      const http = mockHttp([
        ...fixture.catalog([fixture.modelId]),
        ...fixture.catalog([fixture.modelId]),
        fixture.completion(JSON.stringify({ move: "e2e5" })),
        fixture.completion(
          JSON.stringify({ move: "e2e4", commentary: PROVIDER_KEY }),
          fixture.reportedUsage,
        ),
      ]);
      const api = await harness.createAuthenticatedApi({
        aiAdapters: { [fixture.provider]: fixture.createAdapter(http.transport) },
        logger: {
          ...createLoggerOptions("info"),
          stream: { write: (line: string) => logs.push(line) },
        },
      });
      const account = await harness.account(api);
      const credentialId = await save(api, account.cookie, fixture.provider);
      const discovery = await harness.post(api, account.cookie, "/providers/models", {
        provider: fixture.provider,
        credentialId,
      });
      expect(discovery.statusCode, discovery.body).toBe(200);
      expect(discovery.json()).toMatchObject({ ok: true, models: [{ id: fixture.modelId }] });
      const snapshot = await start(api, account.cookie, fixture);
      const body = { ...turnCommand(snapshot), credentialId };
      const result = await harness.post(
        api,
        account.cookie,
        `/games/${snapshot.gameId}/ai-turn`,
        body,
      );
      expect(result.statusCode, result.body).toBe(200);
      expect(gameSnapshotSchema.parse(result.json())).toMatchObject({
        state: "active",
        moves: [{ uci: "e2e4" }],
      });
      const records = await invocations(api, account.cookie, snapshot.gameId);
      expect(records.turns[0]).toMatchObject({
        invalidOutputCount: 1,
        attempts: [
          { outcome: "model_invalid", error: { code: "model_invalid" } },
          { outcome: "accepted", commentary: null, usage: fixture.reportedUsage },
        ],
      });
      const count = http.requests.length;
      expect(count).toBe(fixture.catalog([fixture.modelId]).length * 2 + 2);
      expect(
        http.requests.every((request) =>
          [PROVIDER_KEY, `Bearer ${PROVIDER_KEY}`].includes(fixture.credential(request) ?? ""),
        ),
      ).toBe(true);
      const duplicate = await harness.post(
        api,
        account.cookie,
        `/games/${snapshot.gameId}/ai-turn`,
        body,
      );
      expect(duplicate.statusCode).toBe(409);
      expect(http.requests).toHaveLength(count);
      const persisted = await api.repository.read(async (reader) => ({
        game: await reader.getGame(snapshot.gameId),
        seats: await reader.getParticipants(snapshot.gameId),
        moves: await reader.getMoves(snapshot.gameId),
        attempts: await reader.getModelInvocations(snapshot.gameId),
      }));
      expect(
        JSON.stringify({
          persisted,
          records,
          response: result.json<unknown>(),
          discovery: discovery.json<unknown>(),
          logs,
        }),
      ).not.toContain(PROVIDER_KEY);
      expect(JSON.stringify(persisted)).not.toContain(credentialId);
    },
  );

  it.each(["missing", "foreign", "provider", "tampered", "key-id"] as const)(
    "pauses safely for a %s credential and preserves the retry budget",
    async (kind) => {
      const http = mockHttp([]);
      const api = await harness.createAuthenticatedApi({
        aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
      });
      const account = await harness.account(api);
      const other = kind === "foreign" ? await harness.account(api) : account;
      const credentialId =
        kind === "missing"
          ? randomUUID()
          : await save(api, other.cookie, kind === "provider" ? "google" : "openai");
      if (kind === "tampered" || kind === "key-id") {
        await api.database.db
          .update(providerCredentials)
          .set(kind === "tampered" ? { authTag: "00".repeat(16) } : { keyId: "lost-key" })
          .where(
            and(
              eq(providerCredentials.userId, account.principal.userId),
              eq(providerCredentials.id, credentialId),
            ),
          );
      }
      const discovery = await harness.post(api, account.cookie, "/providers/models", {
        provider: "openai",
        credentialId,
      });
      expect(discovery.json()).toEqual({ ok: false, error: { code: "provider_auth" } });
      const snapshot = await start(api, account.cookie);
      const result = await harness.post(api, account.cookie, `/games/${snapshot.gameId}/ai-turn`, {
        ...turnCommand(snapshot),
        credentialId,
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(gameSnapshotSchema.parse(result.json())).toMatchObject({
        state: "paused",
        result: "*",
        moves: [],
      });
      expect((await invocations(api, account.cookie, snapshot.gameId)).turns[0]).toMatchObject({
        invalidOutputCount: 0,
        attempts: [{ outcome: "provider_error", error: { code: "provider_auth" }, usage: null }],
      });
      expect(http.requests).toHaveLength(0);
    },
  );

  it.each(["discovery", "invalid", "valid"] as const)(
    "rechecks revocation after %s while allowing already-dispatched results",
    async (stage) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const fixture = openAiFixture;
      const catalog = fixture.catalog([fixture.modelId])[0]!;
      const gated = async () => {
        entered.resolve();
        await release.promise;
        if (stage === "discovery") return catalog as Response;
        return fixture.completion(JSON.stringify({ move: stage === "invalid" ? "e2e5" : "e2e4" }));
      };
      const http = mockHttp(stage === "discovery" ? [gated] : [catalog, gated]);
      const api = await harness.createAuthenticatedApi({
        aiAdapters: { openai: fixture.createAdapter(http.transport) },
      });
      const otherApi = await harness.createAuthenticatedApi();
      const account = await harness.account(api);
      const credentialId = await save(api, account.cookie, "openai");
      const snapshot = await start(api, account.cookie);
      const body = { ...turnCommand(snapshot), credentialId };
      const pending = harness.post(api, account.cookie, `/games/${snapshot.gameId}/ai-turn`, body);
      await entered.promise;
      try {
        const duplicate = await harness.post(
          api,
          account.cookie,
          `/games/${snapshot.gameId}/ai-turn`,
          body,
        );
        expect(duplicate.statusCode).toBe(409);
        expect(
          (await harness.post(otherApi, account.cookie, "/credentials/revoke", { credentialId }))
            .statusCode,
        ).toBe(200);
      } finally {
        release.resolve();
      }
      const result = await pending;
      expect(result.statusCode, result.body).toBe(200);
      const current = gameSnapshotSchema.parse(result.json());
      expect(current).toMatchObject({
        state: stage === "valid" ? "active" : "paused",
        result: "*",
      });
      expect(current.moves).toHaveLength(stage === "valid" ? 1 : 0);
      const records = await invocations(api, account.cookie, snapshot.gameId);
      expect(records.turns[0]?.invalidOutputCount).toBe(stage === "invalid" ? 1 : 0);
      expect(records.turns[0]?.attempts.at(-1)?.outcome).toBe(
        stage === "valid" ? "accepted" : "provider_error",
      );
      expect(http.requests).toHaveLength(stage === "discovery" ? 1 : 2);
      if (stage === "valid") {
        const next = await harness.post(api, account.cookie, `/games/${snapshot.gameId}/ai-turn`, {
          ...turnCommand(current),
          credentialId,
        });
        expect(next.json()).toMatchObject({ state: "paused" });
        expect(http.requests).toHaveLength(2);
      }
    },
  );

  it("keeps lifecycle fencing for an in-flight saved-key result", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const http = mockHttp([
      ...openAiFixture.catalog([openAiFixture.modelId]),
      async () => {
        entered.resolve();
        await release.promise;
        return openAiFixture.completion(JSON.stringify({ move: "e2e4" }));
      },
    ]);
    const api = await harness.createAuthenticatedApi({
      aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
    });
    const account = await harness.account(api);
    const credentialId = await save(api, account.cookie, "openai");
    const snapshot = await start(api, account.cookie);
    const pending = harness.post(api, account.cookie, `/games/${snapshot.gameId}/ai-turn`, {
      ...turnCommand(snapshot),
      credentialId,
    });
    await entered.promise;
    try {
      expect(
        (
          await harness.post(
            api,
            account.cookie,
            `/games/${snapshot.gameId}/lifecycle`,
            control(snapshot, "pause"),
          )
        ).statusCode,
      ).toBe(200);
    } finally {
      release.resolve();
    }
    expect((await pending).statusCode).toBe(409);
    const records = await invocations(api, account.cookie, snapshot.gameId);
    expect(records.turns[0]?.attempts[0]?.outcome).toBe("discarded");
    expect(http.requests).toHaveLength(2);
  });

  it.each(fixtures)(
    "pauses for $provider credential rejection and permits explicit session-key recovery",
    async (fixture) => {
      const http = mockHttp([
        ...fixture.catalog([fixture.modelId]),
        fixture.failure("authentication"),
        ...fixture.catalog([fixture.modelId]),
        fixture.completion(JSON.stringify({ move: "e2e4" })),
      ]);
      const api = await harness.createAuthenticatedApi({
        aiAdapters: { [fixture.provider]: fixture.createAdapter(http.transport) },
      });
      const account = await harness.account(api);
      const credentialId = await save(api, account.cookie, fixture.provider);
      const snapshot = await start(api, account.cookie, fixture);
      const pausedResponse = await harness.post(
        api,
        account.cookie,
        `/games/${snapshot.gameId}/ai-turn`,
        { ...turnCommand(snapshot), credentialId },
      );
      const paused = gameSnapshotSchema.parse(pausedResponse.json());
      expect(paused).toMatchObject({ state: "paused", result: "*", moves: [] });
      expect((await invocations(api, account.cookie, snapshot.gameId)).turns[0]).toMatchObject({
        invalidOutputCount: 0,
        attempts: [{ error: { code: "provider_auth" } }],
      });
      const resumed = gameSnapshotSchema.parse(
        (
          await harness.post(
            api,
            account.cookie,
            `/games/${snapshot.gameId}/lifecycle`,
            control(paused, "resume"),
          )
        ).json(),
      );
      const result = await harness.post(api, account.cookie, `/games/${snapshot.gameId}/ai-turn`, {
        ...turnCommand(resumed),
        apiKey: "replacement-session-key",
      });
      expect(result.json()).toMatchObject({ state: "active", moves: [{ uci: "e2e4" }] });
      expect(fixture.credential(http.requests.at(-1)!)).toContain("replacement-session-key");
    },
  );

  it.each([anthropicFixture, googleFixture, openRouterFixture])(
    "stops $provider pagination when the credential is cleared",
    async (fixture) => {
      const pages = fixture.catalog([fixture.modelId, "future-text-model"]);
      expect(pages.length).toBeGreaterThan(1);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const http = mockHttp([
        async () => {
          entered.resolve();
          await release.promise;
          return pages[0] as Response;
        },
        ...pages.slice(1),
      ]);
      const api = await harness.createAuthenticatedApi({
        aiAdapters: { [fixture.provider]: fixture.createAdapter(http.transport) },
      });
      const account = await harness.account(api);
      const credentialId = await save(api, account.cookie, fixture.provider);
      const pending = harness.post(api, account.cookie, "/providers/models", {
        provider: fixture.provider,
        credentialId,
      });
      await entered.promise;
      try {
        expect(
          (await harness.post(api, account.cookie, "/credentials/clear", { confirm: true }))
            .statusCode,
        ).toBe(200);
      } finally {
        release.resolve();
      }
      expect((await pending).json()).toEqual({ ok: false, error: { code: "provider_auth" } });
      expect(http.requests).toHaveLength(1);
    },
  );

  it("resolves identical credential IDs only within the current account", async () => {
    const http = mockHttp([
      ...openAiFixture.catalog([openAiFixture.modelId]),
      ...openAiFixture.catalog([openAiFixture.modelId]),
    ]);
    const api = await harness.createAuthenticatedApi({
      aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
    });
    const first = await harness.account(api);
    const second = await harness.account(api);
    const credentialId = await save(api, first.cookie, "openai");
    await save(api, second.cookie, "openai", { credentialId, apiKey: "second-account-key" });
    for (const account of [first, second]) {
      expect(
        (
          await harness.post(api, account.cookie, "/providers/models", {
            provider: "openai",
            credentialId: credentialId.toUpperCase(),
          })
        ).json(),
      ).toMatchObject({ ok: true });
    }
    expect(openAiFixture.credential(http.requests[0]!)).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(openAiFixture.credential(http.requests[1]!)).toBe("Bearer second-account-key");
  });

  it.each(["missing", "wrong"] as const)(
    "fails closed with a %s deployment key while session-only access remains usable",
    async (kind) => {
      const savingApi = await harness.createAuthenticatedApi();
      const account = await harness.account(savingApi);
      const credentialId = await save(savingApi, account.cookie, "openai");
      const http = mockHttp(openAiFixture.catalog([openAiFixture.modelId]));
      const api = await harness.createAuthenticatedApi({
        credentialCipher:
          kind === "missing"
            ? null
            : createCredentialCipher({
                keyId: "integration-fixture",
                key: Buffer.alloc(32, 8).toString("base64"),
              }),
        aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
      });
      expect(
        (
          await harness.post(api, account.cookie, "/providers/models", {
            provider: "openai",
            credentialId,
          })
        ).json(),
      ).toEqual({ ok: false, error: { code: "provider_auth" } });
      expect(http.requests).toHaveLength(0);
      expect(
        (
          await harness.post(api, account.cookie, "/providers/models", {
            provider: "openai",
            apiKey: PROVIDER_KEY,
          })
        ).json(),
      ).toMatchObject({ ok: true });
      expect(http.requests).toHaveLength(1);
    },
  );

  it("authorizes the account, profile, game, seat and controller before any decryption", async () => {
    const cipher = createCredentialCipher({
      keyId: "integration-fixture",
      key: Buffer.alloc(32, 7).toString("base64"),
    });
    const decrypt = vi.spyOn(cipher, "decrypt");
    const http = mockHttp([]);
    const api = await harness.createAuthenticatedApi({
      credentialCipher: cipher,
      aiAdapters: { openai: openAiFixture.createAdapter(http.transport) },
    });
    const account = await harness.account(api);
    const other = await harness.account(api);
    const incomplete = await harness.account(api, false);
    const guest = await harness.guest(api);
    const credentialId = await save(api, account.cookie, "openai");
    const snapshot = await start(api, account.cookie);
    for (const [cookie, changes, status] of [
      [other.cookie, {}, 404],
      [incomplete.cookie, {}, 403],
      [guest.cookie, {}, 404],
      [account.cookie, { controllerId: randomUUID() }, 409],
      [account.cookie, { expectedVersion: 999 }, 409],
      [account.cookie, { apiKey: PROVIDER_KEY }, 400],
    ] as const) {
      const response = await harness.post(api, cookie, `/games/${snapshot.gameId}/ai-turn`, {
        ...turnCommand(snapshot),
        credentialId,
        ...changes,
      });
      expect(response.statusCode, response.body).toBe(status);
    }
    expect(
      (
        await harness.post(api, incomplete.cookie, "/providers/models", {
          provider: "openai",
          credentialId,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await harness.post(api, guest.cookie, "/providers/models", {
          provider: "openai",
          credentialId,
        })
      ).json(),
    ).toEqual({ ok: false, error: { code: "provider_auth" } });
    const human = await harness.createGame(api, other.cookie, {
      mode: "ai_vs_human",
      seats: {
        white: { type: "human" },
        black: { type: "ai", provider: "openai", modelId: openAiFixture.modelId, parameters: {} },
      },
    });
    expect(
      (
        await harness.post(api, other.cookie, `/games/${human.snapshot.gameId}/ai-turn`, {
          ...turnCommand(human.snapshot),
          credentialId,
        })
      ).statusCode,
    ).toBe(403);
    expect(decrypt).not.toHaveBeenCalled();
    expect(http.requests).toHaveLength(0);
  });
});
