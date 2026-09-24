import { createHash, randomUUID } from "node:crypto";

import { type GameSnapshot, gameSnapshotSchema, type MoveCommand } from "@neurochess/contracts";
import {
  createGameRepository,
  type DatabaseConnection,
  type GameRepository,
  games,
  guestSessions,
} from "@neurochess/database";
import { eq, inArray } from "drizzle-orm";
import { expect } from "vitest";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { AuthService } from "../src/auth/service.js";
import type { AiAdapters } from "../src/games/ai-turn.js";
import { createGameService } from "../src/games/service.js";
import { createGuestService, GUEST_COOKIE_NAME } from "../src/guests/service.js";
import type { GuestPrincipal } from "../src/identity/principal.js";

export const WEB_ORIGIN = "http://localhost:5173";
export const KNIGHT_CYCLE = ["g1f3", "g8f6", "f3g1", "f6g8"];
export const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"];

export interface TestApi {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly database: DatabaseConnection;
  readonly repository: GameRepository;
}

export interface TestGuest {
  readonly id: string;
  readonly principal: GuestPrincipal;
  readonly cookie: string;
  readonly token: string;
}

export class ApiHarness {
  private readonly instances = new Set<TestApi>();
  private readonly guestIds = new Set<string>();

  async createApi(
    options: {
      sandboxEnabled?: boolean;
      nodeEnv?: "development" | "test" | "production";
      ttlSeconds?: number;
      repository?: (repository: GameRepository) => GameRepository;
      logger?: BuildAppOptions["logger"];
      auth?: (database: DatabaseConnection) => AuthService;
      aiAdapters?: AiAdapters;
      providerTimeouts?: { discoveryMs?: number; turnMs?: number };
    } = {},
  ): Promise<TestApi> {
    const database = integrationDatabase();
    const original = createGameRepository(database);
    const repository = options.repository?.(original) ?? original;
    const app = await buildApp({
      logger: options.logger ?? false,
      readiness: database,
      webOrigin: WEB_ORIGIN,
      ...(options.auth
        ? { authApi: { auth: options.auth(database), baseURL: "http://localhost:3001" } }
        : {}),
      gameApi: {
        games: createGameService(repository, {
          nodeEnv: options.nodeEnv ?? "test",
          sandboxEnabled: options.sandboxEnabled ?? true,
          aiAdapters: options.aiAdapters ?? {},
        }),
        guests: createGuestService(repository, options.ttlSeconds ?? 86_400),
        providerTimeouts: options.providerTimeouts ?? {},
      },
    });
    const instance = { app, database, repository };
    this.instances.add(instance);
    return instance;
  }

  async guest(api: TestApi, previousCookie?: string): Promise<TestGuest> {
    const response = await api.app.inject({
      method: "POST",
      url: "/guest-session",
      payload: {},
      headers: { origin: WEB_ORIGIN, ...(previousCookie ? { cookie: previousCookie } : {}) },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    const token = response.cookies.find((cookie) => cookie.name === GUEST_COOKIE_NAME)?.value;
    expect(token).toBeDefined();
    if (!token) throw new Error("Guest cookie missing");
    const [record] = await api.database.db
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.tokenHash, tokenHash(token)));
    if (!record) throw new Error("Guest record missing");
    this.guestIds.add(record.id);
    return {
      id: record.id,
      principal: { kind: "guest", guestSessionId: record.id },
      cookie: `${GUEST_COOKIE_NAME}=${token}`,
      token,
    };
  }

  async close(api: TestApi): Promise<void> {
    await api.app.close();
    await api.database.close();
    this.instances.delete(api);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.instances].map((api) => this.close(api)));
    // Delete only this harness's fixtures, never truncate a configured database.
    if (this.guestIds.size === 0) return;
    const database = integrationDatabase();
    try {
      await database.db.transaction(async (tx) => {
        await tx.delete(games).where(inArray(games.ownerGuestSessionId, [...this.guestIds]));
        await tx.delete(guestSessions).where(inArray(guestSessions.id, [...this.guestIds]));
      });
    } finally {
      await database.close();
      this.guestIds.clear();
    }
  }
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function command(snapshot: GameSnapshot, move: string): MoveCommand {
  return {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: randomUUID(),
    move,
  };
}

export function submit(api: TestApi, guest: TestGuest, move: MoveCommand) {
  return api.app.inject({
    method: "POST",
    url: `/games/${move.gameId}/moves`,
    payload: move,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}

export async function createSandbox(api: TestApi, guest: TestGuest): Promise<GameSnapshot> {
  const response = await api.app.inject({
    method: "POST",
    url: "/sandbox/games",
    payload: {},
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
  expect(response.statusCode, response.body).toBe(201);
  return gameSnapshotSchema.parse(response.json());
}

export async function claimController(api: TestApi, guest: TestGuest, snapshot: GameSnapshot) {
  const response = await api.app.inject({
    method: "POST",
    url: `/games/${snapshot.gameId}/controller`,
    payload: {
      gameId: snapshot.gameId,
      controllerId: snapshot.gameId,
      expectedVersion: snapshot.version,
      action: "acquire",
    },
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
}

export async function snapshot(
  api: TestApi,
  guest: TestGuest,
  gameId: string,
): Promise<GameSnapshot> {
  const response = await api.app.inject({
    method: "GET",
    url: `/games/${gameId}`,
    headers: { cookie: guest.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return gameSnapshotSchema.parse(response.json());
}

export async function play(
  api: TestApi,
  guest: TestGuest,
  initial: GameSnapshot,
  moves: readonly string[],
): Promise<GameSnapshot> {
  let current = initial;
  for (const uci of moves) {
    const response = await submit(api, guest, command(current, uci));
    expect(response.statusCode, response.body).toBe(200);
    current = gameSnapshotSchema.parse(response.json());
  }
  return current;
}
