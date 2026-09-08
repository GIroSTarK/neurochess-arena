import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import {
  aiGameResponseSchema,
  aiTurnRequestSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  providerIdSchema,
} from "@neurochess/contracts";
import {
  gameCommands,
  gameParticipants,
  games,
  modelInvocations,
  moves,
  turnReservations,
} from "@neurochess/database";
import type { APIRequestContext, Page } from "@playwright/test";
import { eq, getTableColumns } from "drizzle-orm";

import { integrationDatabase } from "../database";

import {
  type AcceptanceMatch,
  finishMate,
  fixtureKey,
  humanMove,
  startAiMatch,
} from "./ai-fixtures";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { activate, expect, readSnapshot, test } from "./fixtures";

const headers = { Origin: WEB_ORIGIN };

async function records(gameId: string) {
  const database = integrationDatabase();
  try {
    return {
      game: (await database.db.select().from(games).where(eq(games.id, gameId)))[0]!,
      seats: await database.db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, gameId))
        .orderBy(gameParticipants.color),
      moves: await database.db
        .select()
        .from(moves)
        .where(eq(moves.gameId, gameId))
        .orderBy(moves.ply),
      invocations: await database.db
        .select(getTableColumns(modelInvocations))
        .from(modelInvocations)
        .innerJoin(turnReservations, eq(modelInvocations.reservationId, turnReservations.id))
        .where(eq(modelInvocations.gameId, gameId))
        .orderBy(turnReservations.expectedVersion, modelInvocations.attempt),
      reservations: await database.db
        .select()
        .from(turnReservations)
        .where(eq(turnReservations.gameId, gameId))
        .orderBy(turnReservations.expectedVersion),
      commands: await database.db
        .select()
        .from(gameCommands)
        .where(eq(gameCommands.gameId, gameId))
        .orderBy(gameCommands.version),
    };
  } finally {
    await database.close();
  }
}

function watchTurns(page: Page) {
  const turns: ReturnType<typeof aiTurnRequestSchema.parse>[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) {
      turns.push(aiTurnRequestSchema.parse(request.postDataJSON()));
    }
  });
  return turns;
}

async function control(
  request: APIRequestContext,
  snapshot: GameSnapshot,
  action: "pause" | "abort",
) {
  const response = await request.post(`${API_ORIGIN}/games/${snapshot.gameId}/lifecycle`, {
    headers,
    data: {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: randomUUID(),
      action,
    },
  });
  expect(response.status()).toBe(200);
  return gameSnapshotSchema.parse(await response.json());
}

for (const white of providerIdSchema.options) {
  for (const black of providerIdSchema.options) {
    test(`acceptance: ${white} White vs ${black} Black completes a persisted match${white === black ? " with identical models" : ""}`, async ({
      page,
    }, info) => {
      const match: AcceptanceMatch = {
        mode: "ai_vs_ai",
        white: { provider: white, key: fixtureKey() },
        black: { provider: black, key: fixtureKey() },
      };
      const turns = watchTurns(page);
      const touch = info.project.name === "mobile-touch";
      const { snapshot, configuration } = await startAiMatch(page, match, touch);
      const terminal = await finishMate(page, match, snapshot, touch);
      expect(turns.map(({ expectedVersion }) => expectedVersion)).toEqual([0, 1, 2, 3]);
      expect(turns.map(({ credential }) => credential)).toEqual([
        { provider: white, apiKey: match.white.key },
        { provider: black, apiKey: match.black.key },
        { provider: white, apiKey: match.white.key },
        { provider: black, apiKey: match.black.key },
      ]);
      expect(new Set(turns.map(({ commandId }) => commandId)).size).toBe(4);
      const saved = await records(snapshot.gameId);
      expect(saved.game).toMatchObject({
        state: terminal.state,
        fen: terminal.fen,
        pgn: terminal.pgn,
        version: terminal.version,
      });
      expect(saved.seats).toMatchObject([
        { color: "white", provider: white, modelId: "fixture-full", temperature: 0 },
        { color: "black", provider: black, modelId: "fixture-full", temperature: 1.5 },
      ]);
      expect(
        saved.invocations.map(({ provider, temperature, status }) => [
          provider,
          temperature,
          status,
        ]),
      ).toEqual([
        [white, 0, "succeeded"],
        [black, 1.5, "succeeded"],
        [white, 0, "succeeded"],
        [black, 1.5, "succeeded"],
      ]);
      expect(saved.moves.map(({ commandId }) => commandId)).toEqual(
        turns.map(({ commandId }) => commandId),
      );
      expect(saved.commands).toHaveLength(4);
      expect(saved.reservations.map(({ status }) => status)).toEqual(
        Array<string>(4).fill("committed"),
      );
      for (const seat of [match.white, match.black]) {
        expect(JSON.stringify({ saved, configuration, terminal })).not.toContain(seat.key);
      }
      expect(
        await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
      ).toEqual({ local: 0, session: 0 });
      const unfinished = await page.request.get(API_ORIGIN + "/ai/games/unfinished");
      expect(unfinished.status()).toBe(200);
      expect(await unfinished.json()).toEqual({
        snapshot: null,
      });
    });
  }

  for (const humanColor of ["white", "black"] as const) {
    test(`acceptance: human ${humanColor} completes against ${white}`, async ({ page }, info) => {
      const match: AcceptanceMatch = {
        mode: "ai_vs_human",
        humanColor,
        ai: { provider: white, key: fixtureKey() },
      };
      const turns = watchTurns(page);
      const touch = info.project.name === "mobile-touch";
      const { snapshot } = await startAiMatch(page, match, touch);
      const terminal = await finishMate(page, match, snapshot, touch);
      expect(turns).toHaveLength(2);
      expect(
        turns.every(
          ({ credential }) => credential.provider === white && credential.apiKey === match.ai.key,
        ),
      ).toBe(true);
      expect(terminal.invocations).toHaveLength(2);
      expect(terminal.invocations?.every(({ accepted }) => accepted)).toBe(true);
      expect(await readSnapshot(page, snapshot.gameId)).toEqual(terminal);
    });
  }
}

for (const mode of ["ai_vs_ai", "ai_vs_human"] as const) {
  for (const scenario of ["invalid", "illegal-success"] as const) {
    test(`acceptance: ${mode} exhausts ${scenario} after exactly three invalid outputs`, async ({
      page,
    }, info) => {
      const seat = { provider: "openrouter" as const, key: fixtureKey(scenario) };
      const match: AcceptanceMatch =
        mode === "ai_vs_ai"
          ? { mode, white: seat, black: { provider: "google", key: fixtureKey() } }
          : { mode, humanColor: "white", ai: seat };
      const turns = watchTurns(page);
      const touch = info.project.name === "mobile-touch";
      const { snapshot } = await startAiMatch(page, match, touch);
      if (mode === "ai_vs_human") await humanMove(page, "f2f3", touch);
      await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
      await expect(page.getByText(/Technical loss/).first()).toBeVisible();
      const terminal = await readSnapshot(page, snapshot.gameId);
      expect(terminal).toMatchObject({
        state: "completed",
        terminationReason: "model_technical_loss",
        result: mode === "ai_vs_ai" ? "0-1" : "1-0",
      });
      expect(terminal.moves.map(({ uci }) => uci)).toEqual(mode === "ai_vs_ai" ? [] : ["f2f3"]);
      expect(
        terminal.invocations?.map(({ status, attempt, color }) => [status, attempt, color]),
      ).toEqual(
        [1, 2, 3].map((attempt) => [
          "model_invalid",
          attempt,
          mode === "ai_vs_ai" ? "white" : "black",
        ]),
      );
      for (const attempt of [1, 2, 3]) {
        await expect(
          page.getByText(
            `Ply ${mode === "ai_vs_ai" ? 1 : 2} · ${mode === "ai_vs_ai" ? "White" : "Black"} · Attempt ${attempt}`,
            { exact: true },
          ),
        ).toBeVisible();
      }
      const saved = await records(snapshot.gameId);
      expect(saved.invocations).toHaveLength(3);
      expect(
        saved.invocations.every(({ status, move }) => status === "model_invalid" && move === null),
      ).toBe(true);
      expect(saved.reservations).toHaveLength(1);
      expect(turns).toHaveLength(1);
      const duplicate = await page.request.post(`${API_ORIGIN}/games/${snapshot.gameId}/ai-turn`, {
        headers,
        data: turns[0],
      });
      expect(duplicate.status()).toBe(409);
      await page.waitForTimeout(1_100);
      expect(turns).toHaveLength(1);
      expect((await records(snapshot.gameId)).invocations).toHaveLength(3);
      expect(await readSnapshot(page, snapshot.gameId)).toEqual(terminal);
      const replay = await page.request.get(`${API_ORIGIN}/games/${snapshot.gameId}/replay`);
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({ snapshot: terminal });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width,
      );
      await page.screenshot({
        path: join(tmpdir(), `neurochess-acceptance-${mode}-${scenario}-${info.project.name}.png`),
        fullPage: true,
      });
    });
  }

  for (const [error, message] of [
    ["provider_auth", "Provider authentication failed"],
    ["provider_quota", "Provider quota or rate limit reached"],
    ["provider_timeout", "Provider request timed out"],
    ["provider_unavailable", "Provider unavailable"],
  ] as const) {
    test(`acceptance: ${mode} recovers from ${error} only after user continuation`, async ({
      page,
    }, info) => {
      const seat = { provider: "anthropic" as const, key: fixtureKey(error) };
      const match: AcceptanceMatch =
        mode === "ai_vs_ai"
          ? { mode, white: seat, black: { provider: "google", key: fixtureKey() } }
          : { mode, humanColor: "black", ai: seat };
      const turns = watchTurns(page);
      const touch = info.project.name === "mobile-touch";
      const { snapshot } = await startAiMatch(page, match, touch);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      const paused = await readSnapshot(page, snapshot.gameId);
      expect(paused).toMatchObject({
        state: "paused",
        result: "*",
        terminationReason: null,
        fen: snapshot.fen,
        pgn: snapshot.pgn,
        moves: [],
      });
      expect(paused.invocations).toMatchObject([
        { status: "provider_error", error: { kind: error } },
      ]);
      await page.waitForTimeout(1_100);
      expect(turns).toHaveLength(1);
      if (error === "provider_auth") {
        const saved = aiGameResponseSchema.parse(
          await (await page.request.get(`${API_ORIGIN}/ai/games/${snapshot.gameId}`)).json(),
        );
        expect(saved.snapshot.moves).toEqual(paused.moves);
        await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await activate(page.getByRole("button", { name: "Update key" }), touch);
        const dialog = page.getByRole("dialog", { name: "Update this model's API key" });
        for (const input of await dialog.locator("input").all()) {
          await expect(input).toHaveValue("");
          await expect(input).toHaveAttribute("type", "password");
          await input.fill(fixtureKey());
        }
        await activate(dialog.getByRole("button", { name: "Use keys for this page" }), touch);
        await page.waitForTimeout(1_100);
        expect(turns).toHaveLength(1);
      }
      const retry = page.getByRole("button", {
        name: "Retry move",
        exact: true,
      });
      await expect(retry).toHaveAttribute("aria-disabled", "false");
      await activate(retry, touch);
      await expect
        .poll(async () => (await readSnapshot(page, snapshot.gameId)).moves.length)
        .toBe(1);
      const retried = await readSnapshot(page, snapshot.gameId);
      expect(retried.invocations?.map(({ status }) => status)).toEqual([
        "provider_error",
        "succeeded",
      ]);
      expect(turns).toHaveLength(2);
      expect(turns[1]?.commandId).not.toBe(turns[0]?.commandId);
      expect(turns[1]?.expectedVersion).toBeGreaterThan(turns[0]!.expectedVersion);
      expect(retried.state).toBe("paused");
      await activate(page.getByRole("button", { name: "Resume", exact: true }), touch);
      await finishMate(page, match, snapshot, touch);
    });
  }

  test(`acceptance: ${mode} preserves invalid-output budget across provider failure and manual retry`, async ({
    page,
  }, info) => {
    const seat = { provider: "openai" as const, key: fixtureKey("budget") };
    const match: AcceptanceMatch =
      mode === "ai_vs_ai"
        ? { mode, white: seat, black: { provider: "anthropic", key: fixtureKey() } }
        : { mode, humanColor: "black", ai: seat };
    const turns = watchTurns(page);
    const touch = info.project.name === "mobile-touch";
    const { snapshot } = await startAiMatch(page, match, touch);
    await expect(
      page.getByText("Provider quota or rate limit reached", { exact: true }),
    ).toBeVisible();
    expect(
      (await readSnapshot(page, snapshot.gameId)).invocations?.map(({ status }) => status),
    ).toEqual(["model_invalid", "provider_error"]);
    await activate(page.getByRole("button", { name: "Retry move", exact: true }), touch);
    await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
    const terminal = await readSnapshot(page, snapshot.gameId);
    expect(terminal).toMatchObject({
      state: "completed",
      result: "0-1",
      terminationReason: "model_technical_loss",
      fen: snapshot.fen,
      moves: [],
    });
    expect(terminal.invocations?.map(({ status, attempt }) => [status, attempt])).toEqual([
      ["model_invalid", 1],
      ["provider_error", 2],
      ["model_invalid", 3],
      ["model_invalid", 4],
    ]);
    const saved = await records(snapshot.gameId);
    expect(saved.invocations.map(({ attempt }) => attempt)).toEqual([1, 2, 1, 2]);
    expect(saved.reservations).toHaveLength(2);
    expect(saved.moves).toEqual([]);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.commandId).not.toBe(turns[0]?.commandId);
  });

  test(`acceptance: ${mode} reads and commands stay private in active, paused and terminal states`, async ({
    page,
    browser,
  }, info) => {
    const seat = { provider: "google" as const, key: "fixture-held-private" };
    const match: AcceptanceMatch =
      mode === "ai_vs_ai"
        ? { mode, white: seat, black: seat }
        : { mode, humanColor: "black", ai: seat };
    const { snapshot } = await startAiMatch(page, match, info.project.name === "mobile-touch");
    await expect
      .poll(async () => (await readSnapshot(page, snapshot.gameId)).invocations?.length)
      .toBe(1);
    const isolated = await browser.newContext();
    try {
      const command = { gameId: snapshot.gameId, expectedVersion: 0, commandId: randomUUID() };
      const reads = [
        `/ai/games/${snapshot.gameId}`,
        `/games/${snapshot.gameId}`,
        `/games/${snapshot.gameId}/replay`,
        `/games/${snapshot.gameId}/pgn`,
      ];
      async function denied(status: number) {
        const responses = await Promise.all([
          ...reads.map((path) => isolated.request.get(API_ORIGIN + path)),
          isolated.request.post(`${API_ORIGIN}/games/${snapshot.gameId}/ai-turn`, {
            headers: { ...headers, "x-neurochess-ai-runtime": randomUUID() },
            data: { ...command, credential: { provider: seat.provider, apiKey: seat.key } },
          }),
          isolated.request.post(`${API_ORIGIN}/games/${snapshot.gameId}/moves`, {
            headers,
            data: { ...command, move: "e2e4" },
          }),
          isolated.request.post(`${API_ORIGIN}/games/${snapshot.gameId}/lifecycle`, {
            headers,
            data: { ...command, action: "abort" },
          }),
        ]);
        for (const response of responses) {
          expect(response.status()).toBe(status);
          expect(await response.json()).toMatchObject({
            code: status === 401 ? "UNAUTHORIZED" : "NOT_FOUND",
          });
          const body = await response.text();
          for (const privateValue of [
            snapshot.gameId,
            snapshot.fen,
            seat.key,
            "currentSnapshot",
            "invocations",
            "configuration",
          ]) {
            expect(body).not.toContain(privateValue);
          }
        }
      }
      await denied(401);
      expect(
        (
          await isolated.request.post(API_ORIGIN + "/guest-session", { headers, data: {} })
        ).status(),
      ).toBe(200);
      for (const state of ["active", "paused", "aborted"] as const) {
        if (state !== "active") {
          await control(
            page.request,
            await readSnapshot(page, snapshot.gameId),
            state === "paused" ? "pause" : "abort",
          );
        }
        const before = await readSnapshot(page, snapshot.gameId);
        expect(before.state).toBe(state);
        await denied(404);
        expect(await readSnapshot(page, snapshot.gameId)).toEqual(before);
        expect(
          await (await isolated.request.get(API_ORIGIN + "/ai/games/unfinished")).json(),
        ).toEqual({ snapshot: null });
      }
      const stranger = await isolated.newPage();
      await stranger.goto(WEB_ORIGIN);
      await expect(
        stranger.getByRole("heading", { name: "Choose your contenders." }),
      ).toBeVisible();
      await expect(stranger.getByRole("button", { name: "Return to game" })).toHaveCount(0);
      await expect(stranger.getByRole("grid")).toHaveCount(0);
      expect((await records(snapshot.gameId)).invocations).toHaveLength(1);
    } finally {
      await isolated.close();
    }
  });

  test(`acceptance: ${mode} shares one active or paused slot with every mode and releases it on termination`, async ({
    page,
  }, info) => {
    const seat = { provider: "openai" as const, key: "fixture-held-limit" };
    const match: AcceptanceMatch =
      mode === "ai_vs_ai"
        ? { mode, white: seat, black: seat }
        : { mode, humanColor: "black", ai: seat };
    const { snapshot, configuration } = await startAiMatch(
      page,
      match,
      info.project.name === "mobile-touch",
    );
    const ai = configuration.mode === "ai_vs_ai" ? configuration.white : configuration.ai;
    const creations = [
      { path: "/ai/games", data: { mode: "ai_vs_ai", white: ai, black: ai } },
      { path: "/ai/games", data: { mode: "ai_vs_human", humanColor: "white", ai } },
      { path: "/sandbox/games", data: {} },
    ];
    async function race() {
      return Promise.all(
        creations.map(({ path, data }) => page.request.post(API_ORIGIN + path, { headers, data })),
      );
    }
    for (const state of ["active", "paused"] as const) {
      if (state === "paused") {
        await activate(
          page.getByRole("button", { name: "Pause", exact: true }),
          info.project.name === "mobile-touch",
        );
        await expect(
          page
            .getByRole("region", { name: "Game details" })
            .getByText("Game paused", { exact: true }),
        ).toBeVisible();
      }
      for (const response of await race()) {
        expect(response.status()).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "GAME_CONFLICT",
          currentSnapshot: { gameId: snapshot.gameId, state },
        });
      }
    }
    await activate(
      page.getByRole("button", { name: "Stop game", exact: true }),
      info.project.name === "mobile-touch",
    );
    await activate(
      page.getByRole("dialog").getByRole("button", { name: "Stop game" }),
      info.project.name === "mobile-touch",
    );
    await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
    const raced = await race();
    expect(raced.map((response) => response.status()).sort()).toEqual([201, 409, 409]);
    const winner = gameSnapshotSchema.parse(
      await raced.find((response) => response.status() === 201)!.json(),
    );
    for (const response of raced.filter((response) => response.status() === 409)) {
      expect(await response.json()).toMatchObject({ currentSnapshot: { gameId: winner.gameId } });
    }
    const database = integrationDatabase();
    try {
      const owned = await database.db
        .select()
        .from(games)
        .where(
          eq(games.ownerGuestSessionId, (await records(snapshot.gameId)).game.ownerGuestSessionId),
        );
      expect(
        owned.filter(({ state }) => state === "active" || state === "paused").map(({ id }) => id),
      ).toEqual([winner.gameId]);
    } finally {
      await database.close();
    }
    await control(page.request, winner, "abort");
    const created = await page.request.post(API_ORIGIN + "/ai/games", {
      headers,
      data: creations[1]!.data,
    });
    expect(created.status()).toBe(201);
    const last = gameSnapshotSchema.parse(await created.json());
    const resigned = await page.request.post(`${API_ORIGIN}/games/${last.gameId}/lifecycle`, {
      headers,
      data: {
        gameId: last.gameId,
        expectedVersion: last.version,
        commandId: randomUUID(),
        action: "resign",
        losingColor: "white",
      },
    });
    expect(resigned.status()).toBe(200);
    expect(gameSnapshotSchema.parse(await resigned.json()).state).toBe("completed");
    expect(
      (await page.request.post(API_ORIGIN + "/sandbox/games", { headers, data: {} })).status(),
    ).toBe(201);
  });
}
