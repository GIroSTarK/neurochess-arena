import { randomUUID } from "node:crypto";

import { gameHistoryResponseSchema } from "@neurochess/contracts";
import { authSessions, authUsers, profiles, providerCredentials } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AccountGameHarness } from "./account-game-helpers.js";
import { control } from "./ai-turn-helpers.js";
import { createSandbox, WEB_ORIGIN } from "./helpers.js";
import {
  deletionBody,
  deletionPath,
  gameRecords,
  residualExecution,
  terminalGame,
} from "./history-deletion-helpers.js";

const harness = new AccountGameHarness();
afterEach(() => harness.dispose());

describe("scoped terminal history deletion", () => {
  it.each(["individual", "clear"])(
    "%s deletes every dependent record atomically and permits repeats",
    async (operation) => {
      const api = await harness.createAuthenticatedApi();
      const owner = await harness.account(api);
      const stopped = await terminalGame(harness, api, owner);
      const completed = await terminalGame(harness, api, owner, true);
      await residualExecution(api, stopped);
      const before = await gameRecords(api, stopped.gameId);
      expect(Object.values(before).every((rows) => rows.length > 0)).toBe(true);
      const id = operation === "individual" ? stopped.gameId : undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await harness.post(api, owner.cookie, deletionPath(id), deletionBody(id));
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ status: "deleted" });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      const after = await gameRecords(
        api,
        stopped.gameId,
        before.turns.map((turn) => turn.id),
      );
      expect(Object.values(after).every((rows) => rows.length === 0)).toBe(true);
      for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
        const response = await api.app.inject({
          url: `/games/${stopped.gameId}${suffix}`,
          headers: { cookie: owner.cookie },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
      }
      const history = await api.app.inject({
        url: "/games/history",
        headers: { cookie: owner.cookie },
      });
      expect(
        gameHistoryResponseSchema.parse(history.json()).games.map((game) => game.gameId),
      ).toEqual(operation === "individual" ? [completed.gameId] : []);
    },
  );

  it("preserves unfinished games, unrelated identities, credentials and profile data", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const other = await harness.account(api);
    const guest = await harness.guest(api);
    await terminalGame(harness, api, owner);
    const foreign = await terminalGame(harness, api, other);
    const { snapshot: guestGame } = await harness.createGame(api, guest.cookie);
    const sandbox = await createSandbox(api, guest);
    await harness.post(
      api,
      guest.cookie,
      `/games/${guestGame.gameId}/lifecycle`,
      control(guestGame, "abort"),
    );
    await harness.post(
      api,
      guest.cookie,
      `/games/${sandbox.gameId}/lifecycle`,
      control(sandbox, "abort"),
    );
    const { snapshot: unfinished } = await harness.createGame(api, owner.cookie);
    const credential = await harness.post(api, owner.cookie, "/credentials", {
      credentialId: randomUUID(),
      provider: "openai",
      label: "Preserved",
      apiKey: "fixture-secret-saved-key",
      save: true,
    });
    expect(credential.statusCode, credential.body).toBe(201);
    const keyBefore = await api.database.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, owner.principal.userId));
    const profileBefore = await api.database.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, owner.principal.userId));
    const accountBefore = await api.database.db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, owner.principal.userId));
    const preserved = await Promise.all(
      [foreign.gameId, guestGame.gameId, sandbox.gameId, unfinished.gameId].map((id) =>
        gameRecords(api, id),
      ),
    );
    const second = await owner.anotherSession();
    for (const id of [foreign.gameId, guestGame.gameId, sandbox.gameId, randomUUID()]) {
      const response = await harness.post(
        api,
        `${second.cookie}; ${guest.cookie}`,
        deletionPath(id),
        deletionBody(id),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ status: "deleted" });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const clear = await harness.post(api, second.cookie, deletionPath(), deletionBody());
    expect(clear.statusCode, clear.body).toBe(200);
    expect(
      await Promise.all(
        [foreign.gameId, guestGame.gameId, sandbox.gameId, unfinished.gameId].map((id) =>
          gameRecords(api, id),
        ),
      ),
    ).toEqual(preserved);
    expect(
      await api.database.db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.userId, owner.principal.userId)),
    ).toEqual(keyBefore);
    expect(
      await api.database.db
        .select()
        .from(profiles)
        .where(eq(profiles.userId, owner.principal.userId)),
    ).toEqual(profileBefore);
    expect(
      await api.database.db
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, owner.principal.userId)),
    ).toEqual(accountBefore);
  });

  it.each(["active", "paused"])(
    "rejects deleting an owned %s game instead of stopping it",
    async (state) => {
      const api = await harness.createAuthenticatedApi();
      const owner = await harness.account(api);
      const { snapshot } = await harness.createGame(api, owner.cookie);
      if (state === "paused") {
        await harness.post(api, owner.cookie, `/games/${snapshot.gameId}/lifecycle`, {
          ...control(snapshot, "pause"),
          controllerId: undefined,
        });
      }
      const before = await gameRecords(api, snapshot.gameId);
      const response = await harness.post(
        api,
        owner.cookie,
        deletionPath(snapshot.gameId),
        deletionBody(snapshot.gameId),
      );
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: "INVALID_GAME_STATE" });
      expect(await gameRecords(api, snapshot.gameId)).toEqual(before);
    },
  );

  it("rejects guest/expired/mismatched accounts, unsafe origins, malformed IDs and scope fields", async () => {
    const api = await harness.createAuthenticatedApi();
    const owner = await harness.account(api);
    const guest = await harness.guest(api);
    const incomplete = await harness.account(api, false);
    const snapshot = await terminalGame(harness, api, owner);
    for (const id of [snapshot.gameId, undefined]) {
      const url = deletionPath(id);
      const payload = deletionBody(id);
      for (const cookie of ["", guest.cookie]) {
        expect((await harness.post(api, cookie, url, payload)).statusCode).toBe(401);
      }
      expect((await harness.post(api, incomplete.cookie, url, payload)).statusCode).toBe(403);
      for (const origin of [undefined, "https://foreign.example"]) {
        expect(
          (
            await api.app.inject({
              method: "POST",
              url,
              payload,
              headers: { cookie: owner.cookie, ...(origin ? { origin } : {}) },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(
        (
          await api.app.inject({
            method: "POST",
            url,
            payload,
            headers: {
              origin: WEB_ORIGIN,
              cookie: owner.cookie,
              "x-neurochess-expected-account": randomUUID(),
            },
          })
        ).statusCode,
      ).toBe(401);
      for (const extra of [
        { confirm: false },
        { confirm: "true" },
        { userId: owner.principal.userId },
        { gameIds: [snapshot.gameId] },
      ]) {
        expect(
          (await harness.post(api, owner.cookie, url, { ...payload, ...extra })).statusCode,
        ).toBe(400);
      }
      expect((await harness.post(api, owner.cookie, url, {})).statusCode).toBe(400);
      expect((await harness.post(api, owner.cookie, url + "?all=true", payload)).statusCode).toBe(
        400,
      );
    }
    expect(
      (await harness.post(api, owner.cookie, deletionPath("all"), deletionBody("all"))).statusCode,
    ).toBe(400);
    expect(
      (
        await harness.post(
          api,
          owner.cookie,
          deletionPath(snapshot.gameId),
          deletionBody(randomUUID()),
        )
      ).statusCode,
    ).toBe(400);
    await api.database.db
      .update(authSessions)
      .set({ expiresAt: new Date(0) })
      .where(eq(authSessions.id, owner.principal.sessionId));
    for (const id of [snapshot.gameId, undefined]) {
      expect(
        (
          await harness.post(
            api,
            `${owner.cookie}; ${guest.cookie}`,
            deletionPath(id),
            deletionBody(id),
          )
        ).statusCode,
      ).toBe(401);
    }
    expect((await gameRecords(api, snapshot.gameId)).games).toHaveLength(1);
  });
});
