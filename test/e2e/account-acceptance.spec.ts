import { randomUUID } from "node:crypto";
import { text as streamText } from "node:stream/consumers";

import { gamePgnResponseSchema } from "@neurochess/contracts";
import { authSessions } from "@neurochess/database";
import type { Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { integrationDatabase } from "../database";

import {
  configureCredential,
  credentialAccount,
  saveCredential,
  startCredentialGame,
} from "./credential-helpers";
import { observeCredentialPrivacy } from "./credential-privacy";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, readSnapshot, test } from "./fixtures";

async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto(WEB_ORIGIN + "/auth/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
}

for (const mode of ["ai_vs_ai", "ai_vs_human"] as const) {
  test(`${mode} survives originating-session expiry and completes through explicit recovery on another device`, async ({
    page,
    browser,
    allowedIdentity401s,
  }, testInfo) => {
    const account = await credentialAccount(page);
    const identity = (await (
      await page.request.get(API_ORIGIN + "/api/auth/get-session")
    ).json()) as { user: { id: string } };
    const database = integrationDatabase();
    const device = await browser.newContext({
      viewport: page.viewportSize(),
      isMobile: testInfo.project.name === "mobile-touch",
      hasTouch: testInfo.project.name === "mobile-touch",
    });
    try {
      const sessions = await database.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.userId, identity.user.id));
      expect(sessions).toHaveLength(1);
      const whiteKey = "cross-device-white-fixture-1234";
      const blackKey = "cross-device-black-fixture-5678";
      const draftKey = "expired-page-only-fixture-9012";
      const sentinels = [whiteKey, blackKey, draftKey, account.password];
      const originalPrivacy = observeCredentialPrivacy(page, sentinels);
      await page.goto("/account/credentials");
      const saved = await saveCredential(page, "Cross-device Black", blackKey, "anthropic");
      await page.goto("/");
      await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
      await page.getByLabel("Game mode").selectOption(mode);
      if (mode === "ai_vs_ai") await configureCredential(page, "White", { apiKey: whiteKey });
      await configureCredential(page, "Black", { credentialId: saved.credentialId }, "anthropic");
      const game = await startCredentialGame(page);
      const gameId = game.snapshot.gameId;
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
      const paused = await readSnapshot(page, gameId);
      await page.goto("/account/credentials");
      await page.getByLabel("API key", { exact: true }).fill(draftKey);

      await device.addCookies([
        {
          name: "neurochess_test_client",
          value: randomUUID(),
          url: API_ORIGIN,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ]);
      const recovered = await device.newPage();
      const recoveredPrivacy = observeCredentialPrivacy(recovered, sentinels);
      let bootstraps = 0;
      let turns = 0;
      let savedKeySent = false;
      recovered.on("request", (request) => {
        if (request.url() === API_ORIGIN + "/guest-session") bootstraps++;
        if (request.url().endsWith("/ai-turn")) turns++;
        if (request.postData()?.includes(blackKey)) savedKeySent = true;
      });
      await signIn(recovered, account);
      const secondSessions = await database.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.userId, identity.user.id));
      expect(secondSessions).toHaveLength(2);
      const conflict = await recovered.request.post(API_ORIGIN + "/games", {
        headers: { origin: WEB_ORIGIN, "x-neurochess-identity": "account" },
        data: game.configuration,
      });
      expect(conflict.status()).toBe(409);
      expect(await conflict.json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: { gameId, state: "paused" },
      });

      // The catalog's focus refresh can reach the API before identity observation
      // clears it, or be aborted first. Only this expiry window permits its 401.
      allowedIdentity401s.add(API_ORIGIN + "/credentials");
      const expired = await database.db
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(and(eq(authSessions.userId, identity.user.id), eq(authSessions.id, sessions[0]!.id)))
        .returning({ id: authSessions.id });
      expect(expired).toHaveLength(1);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
      await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Cross-device Black", { exact: true })).toHaveCount(0);
      allowedIdentity401s.clear();
      expect(
        (
          await page.request.get(`${API_ORIGIN}/games/${gameId}`, {
            headers: { "x-neurochess-identity": "account" },
          })
        ).status(),
      ).toBe(401);
      await originalPrivacy();

      await recovered.getByRole("button", { name: "Return to game", exact: true }).click();
      await expect(
        recovered.getByRole("heading", { name: "Game paused", exact: true }),
      ).toBeVisible();
      await expect(recovered.getByRole("grid")).toHaveAttribute("data-fen", paused.fen);
      await expect(recovered.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
      const colors = mode === "ai_vs_ai" ? ["White", "Black"] : ["Black"];
      for (const color of colors) {
        const provider = color === "White" ? "OpenAI" : "Anthropic";
        await expect(
          recovered.getByLabel(`${color} · ${provider} · Credential source`),
        ).toHaveValue("session");
        await expect(
          recovered.getByLabel(`${color} · ${provider} · API key`, { exact: true }),
        ).toHaveValue("");
      }
      if (mode === "ai_vs_ai") {
        await recovered.getByLabel("White · OpenAI · API key", { exact: true }).fill(whiteKey);
      }
      await recovered
        .getByLabel("Black · Anthropic · Credential source")
        .selectOption(saved.credentialId);
      expect(turns).toBe(0);
      expect(await readSnapshot(recovered, gameId)).toMatchObject({
        state: "paused",
        moves: paused.moves,
      });
      await recovered.getByRole("button", { name: "Resume game", exact: true }).click();
      if (mode === "ai_vs_human") {
        for (const [from, to, ply] of [
          ["f2", "f3", 2],
          ["g2", "g4", 4],
        ] as const) {
          await expect(recovered.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
          await recovered.locator(`[data-square="${from}"]`).click();
          await recovered.locator(`[data-square="${to}"]`).click();
          await expect
            .poll(async () => (await readSnapshot(recovered, gameId)).moves.length)
            .toBe(ply);
        }
      }
      await expect(
        recovered.getByRole("heading", { name: "Black wins by checkmate" }),
      ).toBeVisible();
      const completed = await readSnapshot(recovered, gameId);
      expect(completed).toMatchObject({
        state: "completed",
        result: "0-1",
        terminationReason: "checkmate",
      });
      expect(completed.moves.map((move) => move.uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);
      expect(turns).toBeGreaterThan(0);
      expect(bootstraps).toBe(0);
      expect(savedKeySent).toBe(false);
      await recoveredPrivacy();

      await signIn(page, account);
      await page.getByRole("link", { name: "History", exact: true }).click();
      await expect(
        page.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
      ).toHaveCount(1);
      await page.locator(`a[href="/?game=${gameId}"]`).click();
      await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
      await expect(page.getByLabel(/API key/)).toHaveCount(0);
      const canonical = gamePgnResponseSchema.parse(
        await (await page.request.get(`${API_ORIGIN}/games/${gameId}/pgn`)).json(),
      );
      expect(canonical.pgn).toBe(completed.pgn);
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download PGN", exact: true }).click();
      const stream = await (await downloading).createReadStream();
      expect(stream).not.toBeNull();
      expect(await streamText(stream)).toBe(canonical.pgn);
      await originalPrivacy();
      await page.screenshot({
        path: testInfo.outputPath(`${mode}-cross-device-result.png`),
        fullPage: true,
      });
    } finally {
      await device.close();
      await database.close();
    }
  });
}
