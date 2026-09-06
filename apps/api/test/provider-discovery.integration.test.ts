import {
  gameSnapshotSchema,
  type ModelDiscoveryResult,
  providerErrorKindSchema,
  type SessionCredential,
} from "@neurochess/contracts";
import { gameCommands, games, guestSessions } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createLoggerOptions } from "../src/logger.js";
import type { AiProviderAdapter } from "../src/providers/adapter.js";

import {
  aiCommand,
  createAi,
  creation,
  lifecycle,
  mock,
  model,
  post,
  records,
  runtime,
  turn,
  white,
} from "./ai-helpers.js";
import { ApiHarness, snapshot, WEB_ORIGIN } from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
const credential: SessionCredential = { provider: "openai", apiKey: "discovery-http-key-canary" };

describe("secure provider discovery HTTP boundary", () => {
  it("requires an existing guest and exact Origin, validates inputs, and only lists registered providers", async () => {
    let calls = 0;
    const provider = mock([]);
    const adapter: AiProviderAdapter = {
      ...provider,
      async listModels(input) {
        calls++;
        return provider.listModels(input);
      },
    };
    const api = await harness.createApi({ ai: { providers: [{ adapter }] } });
    const guest = await harness.guest(api);
    expect((await api.app.inject({ method: "GET", url: "/ai/providers" })).statusCode).toBe(401);
    const listed = await api.app.inject({
      method: "GET",
      url: "/ai/providers",
      headers: { cookie: guest.cookie },
    });
    expect(listed.json()).toEqual({ providers: [provider.descriptor] });
    expect(listed.headers["cache-control"]).toBe("no-store");
    for (const [headers, status] of [
      [{ origin: WEB_ORIGIN }, 401],
      [{ origin: WEB_ORIGIN, cookie: "__Host-neurochess_guest=invalid" }, 401],
      [{ cookie: guest.cookie }, 403],
      [{ cookie: guest.cookie, origin: "http://untrusted.test" }, 403],
    ] as const) {
      const rejected = await api.app.inject({
        method: "POST",
        url: "/ai/models",
        payload: { credential },
        headers,
      });
      expect(rejected.statusCode).toBe(status);
      expect(rejected.headers["cache-control"]).toBe("no-store");
      expect(rejected.cookies).toEqual([]);
    }
    for (const payload of [
      {},
      { apiKey: credential.apiKey },
      { credential: { ...credential, apiKey: "" } },
      { credential: { ...credential, provider: "unknown" } },
      { credential, models: [model] },
      { credential, white: credential },
      { credential: { ...credential, save: true } },
    ]) {
      expect((await post(api, guest, "/ai/models", payload)).statusCode).toBe(400);
    }
    expect(
      (await post(api, guest, `/ai/models?apiKey=${credential.apiKey}`, { credential })).statusCode,
    ).toBe(400);
    expect(
      (await post(api, guest, "/ai/models", { credential: { ...credential, provider: "google" } }))
        .statusCode,
    ).toBe(404);
    expect(calls).toBe(0);
    const discovered = await post(api, guest, "/ai/models", { credential });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json()).toEqual({ ok: true, value: [model] });
    expect(discovered.headers["cache-control"]).toBe("no-store");
    expect(calls).toBe(1);
    await api.database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() - interval '1 hour'`,
      })
      .where(eq(guestSessions.id, guest.id));
    expect((await post(api, guest, "/ai/models", { credential })).statusCode).toBe(401);
    expect(calls).toBe(1);
    const unconfigured = await harness.createApi({ nodeEnv: "production", sandboxEnabled: false });
    const other = await harness.guest(unconfigured);
    expect(
      (
        await unconfigured.app.inject({
          method: "GET",
          url: "/ai/providers",
          headers: { cookie: other.cookie },
        })
      ).json(),
    ).toEqual({ providers: [] });
    expect((await post(unconfigured, other, "/ai/models", { credential })).statusCode).toBe(404);
  });

  it.each(providerErrorKindSchema.options)(
    "returns safe %s discovery failures without changing an existing game",
    async (kind) => {
      const provider = mock([]);
      const adapter: AiProviderAdapter = {
        ...provider,
        async listModels() {
          return { ok: false, error: { kind } };
        },
      };
      const api = await harness.createApi({ ai: runtime(adapter) });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest);
      const before = await records(api, initial.gameId);
      const response = await post(api, guest, "/ai/models", { credential });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: false, error: { kind } });
      expect(response.body).not.toContain(credential.apiKey);
      expect(await records(api, initial.gameId)).toEqual(before);
      expect(provider.requests).toHaveLength(0);
    },
  );

  it("uses discovered capabilities, requires a fresh key per turn, and persists no credentials", async () => {
    const provider = mock([{ output: { move: "e2e4" } }, { output: { move: "e7e5" } }]);
    const observed: boolean[] = [];
    const adapter: AiProviderAdapter = {
      ...provider,
      async listModels(input) {
        observed.push(input.apiKey === credential.apiKey);
        return provider.listModels(input);
      },
      async requestMove(input) {
        observed.push(
          input.apiKey ===
            (input.context.color === "white" ? "white-turn-key-canary" : "black-turn-key-canary"),
        );
        return provider.requestMove(input);
      },
    };
    const chunks: string[] = [];
    const api = await harness.createApi({
      ai: { providers: [{ adapter }] },
      logger: {
        ...createLoggerOptions("info"),
        stream: {
          write: (chunk: string) => {
            chunks.push(chunk);
          },
        },
      },
    });
    const guest = await harness.guest(api);
    const other = await harness.guest(api);
    expect((await post(api, guest, "/ai/games", creation)).statusCode).toBe(400);
    expect((await post(api, guest, "/ai/models", { credential })).statusCode).toBe(200);
    expect((await post(api, other, "/ai/games", creation)).statusCode).toBe(400);
    expect((await post(api, guest, "/ai/games", { ...creation, credential })).statusCode).toBe(400);
    expect(
      (
        await post(api, guest, "/ai/games", {
          ...creation,
          white: { ...white, parameters: { temperature: 3 } },
        })
      ).statusCode,
    ).toBe(400);
    let current = await createAi(api, guest, {
      ...creation,
      white: { ...white, parameters: { temperature: 0, reasoningEffort: "unsupported" } },
    });
    const initial = current;
    expect(
      (await post(api, guest, `/games/${current.gameId}/ai-turn`, aiCommand(current))).statusCode,
    ).toBe(400);
    expect(
      (await turn(api, guest, aiCommand(current), { ...credential, provider: "google" }))
        .statusCode,
    ).toBe(400);
    expect((await turn(api, other, aiCommand(current), credential)).statusCode).toBe(404);
    expect((await records(api, current.gameId)).reservations).toHaveLength(0);
    const whiteKey: SessionCredential = { provider: "openai", apiKey: "white-turn-key-canary" };
    const blackKey: SessionCredential = { provider: "openai", apiKey: "black-turn-key-canary" };
    const first = await turn(api, guest, aiCommand(current), whiteKey);
    expect(first.statusCode).toBe(200);
    current = gameSnapshotSchema.parse(first.json());
    expect(provider.requests[0]?.configuration.parameters).toEqual({ temperature: 0 });
    expect((await turn(api, guest, aiCommand(initial), whiteKey)).statusCode).toBe(409);
    const paused = gameSnapshotSchema.parse((await lifecycle(api, guest, current, "pause")).json());
    const restarted = await harness.createApi({ ai: { providers: [{ adapter }] } });
    expect(
      (await post(restarted, guest, `/games/${current.gameId}/ai-turn`, aiCommand(paused)))
        .statusCode,
    ).toBe(400);
    const second = await turn(restarted, guest, aiCommand(paused), blackKey);
    expect(second.statusCode).toBe(200);
    current = gameSnapshotSchema.parse(second.json());
    expect(current).toMatchObject({ state: "paused", version: 3 });
    expect(await snapshot(api, guest, current.gameId)).toEqual(current);
    expect(observed).toEqual([true, true, true]);
    const stored = await records(api, current.gameId);
    expect(stored.participants.find((seat) => seat.color === "white")).toMatchObject({
      temperature: 0,
      reasoningEffort: null,
    });
    expect(stored.invocations[0]).toMatchObject({
      temperature: 0,
      reasoningEffort: null,
      status: "succeeded",
    });
    const commands = await api.database.db
      .select()
      .from(gameCommands)
      .where(eq(gameCommands.gameId, current.gameId));
    const guests = await api.database.db
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, guest.id));
    const artifacts =
      JSON.stringify({
        stored,
        commands,
        guests,
        captures: provider.requests,
        responses: [first.json(), second.json()],
      }) + chunks.join("");
    for (const key of [credential.apiKey, whiteKey.apiKey, blackKey.apiKey]) {
      expect(artifacts).not.toContain(key);
    }
    expect(JSON.stringify({ stored, commands, guests })).not.toMatch(
      /apiKey|credential|authorization/i,
    );
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, other.id))).toBe(0);
  });

  it("isolates concurrent guests' turn keys and reuses only the current HTTP key for automatic retries", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const provider = mock([
      { output: { move: "e2e5" } },
      { output: { move: "d2d4" } },
      { output: { move: "e2e4" } },
    ]);
    let calls = 0;
    const matched: boolean[] = [];
    const adapter: AiProviderAdapter = {
      ...provider,
      async requestMove(input) {
        if (++calls === 2) entered.resolve();
        await release.promise;
        matched.push(
          input.apiKey ===
            (input.configuration.parameters.temperature === 0
              ? "first-guest-turn-key"
              : "second-guest-turn-key"),
        );
        return provider.requestMove(input);
      },
    };
    const api = await harness.createApi({ ai: runtime(adapter) });
    const firstGuest = await harness.guest(api);
    const secondGuest = await harness.guest(api);
    const first = await createAi(api, firstGuest);
    const second = await createAi(api, secondGuest, {
      ...creation,
      white: { ...white, parameters: { temperature: 1 } },
    });
    const pending = [
      turn(api, firstGuest, aiCommand(first), {
        provider: "openai",
        apiKey: "first-guest-turn-key",
      }).then((result) => result),
      turn(api, secondGuest, aiCommand(second), {
        provider: "openai",
        apiKey: "second-guest-turn-key",
      }).then((result) => result),
    ];
    try {
      await entered.promise;
    } finally {
      release.resolve();
    }
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(calls).toBe(3);
    expect(matched).toEqual([true, true, true]);
    const stored = JSON.stringify([
      await records(api, first.gameId),
      await records(api, second.gameId),
    ]);
    expect(stored).not.toContain("first-guest-turn-key");
    expect(stored).not.toContain("second-guest-turn-key");
  });

  it("redacts malformed requests, unknown fields, model-name echoes, and arbitrary discovery exceptions", async () => {
    const chunks: string[] = [];
    const provider = mock([]);
    let response: unknown = { ok: true, value: [model], raw: credential };
    let throws = false;
    const adapter: AiProviderAdapter = {
      ...provider,
      async listModels() {
        if (throws) {
          throw Object.assign(new Error(credential.apiKey), {
            code: credential.apiKey,
            name: credential.apiKey,
            cause: { credential },
          });
        }
        return response as ModelDiscoveryResult;
      },
    };
    const api = await harness.createApi({
      ai: { providers: [{ adapter }] },
      logger: {
        ...createLoggerOptions("info"),
        stream: {
          write: (chunk: string) => {
            chunks.push(chunk);
          },
        },
      },
    });
    const guest = await harness.guest(api);
    for (const result of [
      response,
      { ok: true, value: [{ ...model, name: credential.apiKey }] },
      { ok: true, value: [{ ...model, id: credential.apiKey }] },
      { ok: false, error: { kind: "provider_auth", message: credential.apiKey } },
    ]) {
      response = result;
      const failed = await post(api, guest, "/ai/models", { credential });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "The server could not complete the request.",
      });
      expect(failed.body).not.toContain(credential.apiKey);
      expect((await post(api, guest, "/ai/games", creation)).statusCode).toBe(400);
    }
    throws = true;
    expect((await post(api, guest, "/ai/models", { credential })).statusCode).toBe(500);
    const malformed = await api.app.inject({
      method: "POST",
      url: "/ai/models",
      payload: `{"credential":{"apiKey":"${credential.apiKey}"`,
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie, "content-type": "application/json" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(credential.apiKey);
    expect(chunks.join("")).not.toContain(credential.apiKey);
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, guest.id))).toBe(0);
  });

  it.each(["commentary", "providerRequestId", "extra", "throw"] as const)(
    "never persists a key echoed in move %s",
    async (field) => {
      const provider = mock([]);
      const adapter: AiProviderAdapter = {
        ...provider,
        async requestMove(input) {
          if (field === "throw") {
            throw Object.assign(new Error(input.apiKey), {
              code: input.apiKey,
              name: input.apiKey,
              request: input,
            });
          }
          return {
            ok: true,
            value: { move: "e2e4", latencyMs: 0, usage: null, [field]: input.apiKey },
          };
        },
      };
      const chunks: string[] = [];
      const api = await harness.createApi({
        ai: runtime(adapter),
        logger: {
          ...createLoggerOptions("info"),
          stream: {
            write: (chunk: string) => {
              chunks.push(chunk);
            },
          },
        },
      });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest);
      const response = await turn(api, guest, aiCommand(initial), credential);
      expect(response.statusCode).toBe(500);
      const stored = await records(api, initial.gameId);
      expect(stored.moves).toHaveLength(0);
      expect(stored.invocations[0]).toMatchObject({
        status: "pending",
        commentary: null,
        providerRequestId: null,
      });
      expect(JSON.stringify(stored) + response.body + chunks.join("")).not.toContain(
        credential.apiKey,
      );
    },
  );
});
