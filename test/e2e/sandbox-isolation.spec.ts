import { type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, playMove, readSnapshot, startSandbox, submitGame, test } from "./fixtures";

async function startAi(page: Page, mode: "ai_vs_ai" | "ai_vs_human") {
  await expect(page.getByRole("heading", { name: "Set up a game", exact: true })).toBeVisible();
  await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
  await page.getByLabel("Game mode").selectOption(mode);
  if (mode === "ai_vs_human") await page.getByLabel("Your color").selectOption("white");
  for (const color of mode === "ai_vs_ai" ? ["White", "Black"] : ["Black"]) {
    const seat = page.getByRole("group", { name: color, exact: true });
    await seat.getByLabel("API key", { exact: true }).fill("slow-fixture");
    await seat.getByRole("button", { name: "Load models", exact: true }).click();
    const model = seat.getByRole("combobox", { name: "Model", exact: true });
    await expect(model).toHaveAttribute("aria-disabled", "false");
    await model.fill("model-a");
    await model.press("ArrowDown");
    await model.press("Enter");
  }
  const { details } = await submitGame(page);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  return readSnapshot(page, details.snapshot.gameId);
}

for (const mode of ["ai_vs_ai", "ai_vs_human"] as const) {
  for (const sandboxFirst of [false, true]) {
    test(`${mode} and Sandbox retain separate games when ${sandboxFirst ? "Sandbox" : "Arena"} starts first`, async ({
      page,
    }, testInfo) => {
      const touch = testInfo.project.name === "mobile-touch";
      let sandbox: GameSnapshot | undefined;
      if (sandboxFirst) {
        sandbox = await startSandbox(page, touch);
        sandbox = await playMove(page, sandbox, "e2e4", touch);
        await page.getByRole("link", { name: "Arena", exact: true }).click();
      } else await page.goto("/");
      const pausedAi = await startAi(page, mode);
      expect(pausedAi.state).toBe("paused");

      await page.getByRole("link", { name: "Sandbox", exact: true }).click();
      if (sandbox) {
        await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
        await expect(page.getByRole("grid")).toHaveAttribute("data-fen", sandbox.fen);
      } else {
        await expect(
          page.getByRole("button", { name: "Start sandbox", exact: true }),
        ).toBeEnabled();
        sandbox = await startSandbox(page, touch);
        sandbox = await playMove(page, sandbox, "e2e4", touch);
        await page.getByRole("button", { name: "Pause", exact: true }).click();
        await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
      }
      expect(sandbox.gameId).not.toBe(pausedAi.gameId);
      const pausedSandbox = await readSnapshot(page, sandbox.gameId);
      expect(pausedSandbox.state).toBe("paused");
      expect(pausedSandbox.moves).toEqual(sandbox.moves);
      const resumedResponse = page.waitForResponse(
        (response) => response.url() === `${API_ORIGIN}/games/${pausedSandbox.gameId}/lifecycle`,
      );
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      const resumed = await resumedResponse;
      expect(resumed.status()).toBe(200);
      sandbox = gameSnapshotSchema.parse(await resumed.json());
      expect(sandbox).toMatchObject({
        gameId: pausedSandbox.gameId,
        state: "active",
        version: pausedSandbox.version + 1,
        fen: pausedSandbox.fen,
        moves: pausedSandbox.moves,
      });
      sandbox = await playMove(page, sandbox, "e7e5", touch);
      expect(await readSnapshot(page, pausedAi.gameId)).toEqual(pausedAi);
      await page.screenshot({ path: testInfo.outputPath("isolated-sandbox.png"), fullPage: true });

      await page.reload();
      await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
      await expect(page.getByRole("grid")).toHaveAttribute("data-fen", sandbox.fen);
      const recoveredSandbox = await readSnapshot(page, sandbox.gameId);
      expect(recoveredSandbox).toMatchObject({
        gameId: sandbox.gameId,
        state: "paused",
        moves: sandbox.moves,
        fen: sandbox.fen,
      });
      await page.getByRole("link", { name: "Arena", exact: true }).click();
      await page.getByRole("button", { name: "Return to game", exact: true }).click();
      await expect(page).toHaveURL(new RegExp("/games/" + pausedAi.gameId + "$"));
      await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
      expect(await readSnapshot(page, pausedAi.gameId)).toEqual({
        ...pausedAi,
        version: pausedAi.version + 1,
      });
      expect(await readSnapshot(page, sandbox.gameId)).toEqual(recoveredSandbox);

      await page.goBack();
      await expect(page).toHaveURL(WEB_ORIGIN + "/");
      await expect(page.getByRole("button", { name: "Return to game", exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp("/sandbox/games/" + sandbox.gameId + "$"));
      await expect(page.getByRole("grid")).toHaveAttribute("data-fen", recoveredSandbox.fen);
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      expect(await readSnapshot(page, sandbox.gameId)).toEqual(recoveredSandbox);
      await page.goForward();
      await expect(page).toHaveURL(WEB_ORIGIN + "/");
      await expect(page.getByRole("button", { name: "Return to game", exact: true })).toBeVisible();
      await page.goForward();
      await expect(page).toHaveURL(new RegExp("/games/" + pausedAi.gameId + "$"));
      await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
      expect(await readSnapshot(page, sandbox.gameId)).toEqual(recoveredSandbox);
    });
  }
}
