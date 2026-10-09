import { authUsers, games, guestSessions } from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";

import { RoomHistoryHarness } from "./room-history-helpers.js";

const harness = new RoomHistoryHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

it.each(["account", "delete", "clear"] as const)(
  "acknowledges committed %s deletion when its post-commit cleanup fails",
  async (action) => {
    const { api, owner, opponent, snapshot } = await harness.room({
      guest: true,
      state: action === "account" ? "active" : "completed",
    });
    if (opponent.principal.kind !== "guest") throw new Error("Expected guest");
    await api.database.db
      .update(guestSessions)
      .set({ lastSeenAt: new Date(0), expiresAt: new Date(1) })
      .where(eq(guestSessions.id, opponent.principal.guestSessionId));
    // Only the post-commit sweep uses this query; the real deletion still commits.
    const failure = vi.spyOn(api.database.db, "selectDistinct").mockImplementation(() => {
      throw new Error("private-cleanup-failure-canary");
    });
    const path =
      action === "account"
        ? "/api/auth/delete-account"
        : action === "clear"
          ? "/games/history/clear"
          : `/games/${snapshot.gameId}/delete`;
    const response = await harness.post(api, owner.cookie, path, {
      confirm: true,
      ...(action === "delete" ? { gameId: snapshot.gameId } : {}),
    });
    failure.mockRestore();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(
      action === "account" ? { success: true } : { status: "deleted" },
    );
    expect(response.body).not.toContain("canary");
    if (action === "account") {
      expect(response.cookies.some((cookie) => cookie.value === "" && cookie.maxAge === 0)).toBe(
        true,
      );
      expect(
        await api.database.db.$count(authUsers, eq(authUsers.id, owner.principal.userId)),
      ).toBe(0);
    } else {
      expect(
        await api.repository.read((reader) =>
          reader.hasRetainedRoomAccess(snapshot.gameId, owner.principal.userId),
        ),
      ).toBe(false);
    }
    expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(1);
    const restarted = await harness.createAuthenticatedApi();
    await restarted.app.ready();
    expect(await api.database.db.$count(games, eq(games.id, snapshot.gameId))).toBe(0);
  },
);
