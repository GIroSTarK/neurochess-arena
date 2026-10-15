import {
  roomCreationOperationSchema,
  roomIssuedResponseSchema,
  roomViewSchema,
} from "@neurochess/contracts";
import { games } from "@neurochess/database";
import { inArray } from "drizzle-orm";
import { expect } from "vitest";

import { AccountGameHarness } from "./account-game-helpers.js";
import type { TestApi } from "./helpers.js";

export class RoomApiHarness extends AccountGameHarness {
  private readonly roomIds = new Set<string>();

  override async post(api: TestApi, cookie: string, url: string, payload: object) {
    const response = await super.post(api, cookie, url, payload);
    if (url === "/rooms" && response.statusCode === 200) {
      this.roomIds.add(roomIssuedResponseSchema.parse(response.json()).room.snapshot.gameId);
    }
    return response;
  }

  override async dispose() {
    const database = this.openDatabase();
    try {
      if (this.roomIds.size) {
        await database.db.delete(games).where(inArray(games.id, [...this.roomIds]));
      }
      this.roomIds.clear();
    } finally {
      await database.close();
      await super.dispose();
    }
  }

  async operation(api: TestApi, cookie: string) {
    const response = await this.post(api, cookie, "/rooms/creation-operation", {});
    expect(response.statusCode, response.body).toBe(200);
    return roomCreationOperationSchema.parse(response.json());
  }

  async room(
    ownerColor: "white" | "black" = "white",
    options: Parameters<AccountGameHarness["createAuthenticatedApi"]>[0] = {},
  ) {
    const api = await this.createAuthenticatedApi(options);
    const owner = await this.account(api);
    const operation = await this.operation(api, owner.cookie);
    const payload = { operationId: operation.operationId, ownerColor };
    const response = await this.post(api, owner.cookie, "/rooms", payload);
    expect(response.statusCode, response.body).toBe(200);
    const result = roomIssuedResponseSchema.parse(response.json());
    if (result.invitation === null) throw new Error("New room has no invitation");
    return { api, owner, operation, payload, room: result.room, invitation: result.invitation };
  }

  async join(api: TestApi, cookie: string, invitation: string, commandId: string) {
    const response = await this.post(api, cookie, "/rooms/join", { invitation, commandId });
    expect(response.statusCode, response.body).toBe(200);
    return roomViewSchema.parse(response.json());
  }

  async view(api: TestApi, cookie: string, gameId: string) {
    const response = await api.app.inject({ url: `/rooms/${gameId}`, headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    return roomViewSchema.parse(response.json());
  }
}
