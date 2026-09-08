import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { type AiTurnRequest, aiTurnRequestSchema } from "@neurochess/contracts";

import { type AcceptanceMatch, fixtureKey, humanMove, startAiMatch } from "./ai-fixtures";
import { activate, expect, readSnapshot, test } from "./fixtures";

for (const mode of ["ai_vs_ai", "ai_vs_human"] as const) {
  test(`${mode} shows both retries and live attempts before the turn response`, async ({
    page,
  }, info) => {
    const touch = info.project.name === "mobile-touch";
    const seat = { provider: "openai" as const, key: fixtureKey("live-retries") };
    const match: AcceptanceMatch =
      mode === "ai_vs_ai"
        ? { mode, white: seat, black: { provider: "openai", key: fixtureKey() } }
        : { mode, humanColor: "black", ai: seat };
    let responses = 0;
    page.on("response", (response) => {
      if (response.url().endsWith("/ai-turn")) responses++;
    });
    const { snapshot } = await startAiMatch(page, match, touch);
    const board = page.getByRole("grid", { name: "Chessboard" });
    const controls = page.getByRole("group", {
      name: mode === "ai_vs_ai" ? "AI playback controls" : "AI versus human controls",
    });
    const pause = controls.getByRole("button").first();
    await pause.focus();
    const before = await controls.boundingBox();
    for (const retry of [1, 2]) {
      await expect(
        page.getByText(`Invalid response. Retrying (${retry} of 2)…`, { exact: true }),
      ).toBeVisible();
      expect(responses).toBe(0);
      await expect(board).toHaveAttribute("data-fen", snapshot.fen);
      await expect(pause).toBeFocused();
      await expect(
        page.getByText(`Ply 1 · White · Attempt ${retry + 1}`, { exact: true }),
      ).toBeVisible();
      expect(await controls.boundingBox()).toEqual(before);
      if (retry === 2) {
        await page.screenshot({
          path: join(tmpdir(), `neurochess-retry-${mode}-${info.project.name}.png`),
          fullPage: true,
        });
      }
    }
    await activate(pause, touch);
    await expect(
      page.getByRole("region", { name: "Game details" }).getByText("Game paused", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/Invalid response\. Retrying/).filter({ visible: true }),
    ).toHaveCount(0);
    await expect(board).toHaveAttribute("data-fen", snapshot.fen);
    await expect(pause).toBeFocused();
    const secured = await readSnapshot(page, snapshot.gameId);
    expect(secured.invocations?.map(({ status }) => status)).toEqual([
      "model_invalid",
      "model_invalid",
      "abandoned",
    ]);
    await page.waitForTimeout(600);
    expect((await readSnapshot(page, snapshot.gameId)).moves).toEqual([]);
  });

  for (const color of ["white", "black"] as const) {
    test(`${mode} corrects only the rejected ${color} key without reloading`, async ({
      page,
    }, info) => {
      const touch = info.project.name === "mobile-touch";
      const failed = { provider: "openai" as const, key: fixtureKey("provider_auth") };
      const other = { provider: "openai" as const, key: fixtureKey() };
      const match: AcceptanceMatch =
        mode === "ai_vs_ai"
          ? {
              mode,
              white: color === "white" ? failed : other,
              black: color === "black" ? failed : other,
            }
          : { mode, humanColor: color === "white" ? "black" : "white", ai: failed };
      const turns: AiTurnRequest[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith("/ai-turn")) {
          turns.push(aiTurnRequestSchema.parse(request.postDataJSON()));
        }
      });
      const { snapshot, configuration } = await startAiMatch(page, match, touch);
      if (mode === "ai_vs_human" && color === "black") await humanMove(page, "f2f3", touch);
      const panel = page.locator(`[data-seat="${color}"]`);
      await expect(
        panel.getByText("This key was rejected. Update it, then retry the move."),
      ).toBeVisible();
      const paused = await readSnapshot(page, snapshot.gameId);
      const count = turns.length;
      const retry = page
        .getByRole("group", {
          name: mode === "ai_vs_ai" ? "AI playback controls" : "AI versus human controls",
        })
        .getByRole("button")
        .nth(1);
      await expect(retry).toHaveAccessibleName("Retry move");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: join(tmpdir(), `neurochess-key-${mode}-${color}-${info.project.name}.png`),
        fullPage: true,
      });
      const update = panel.getByRole("button", { name: "Update key" });
      await activate(update, touch);
      const dialog = page.getByRole("dialog", { name: "Update this model's API key" });
      const input = dialog.getByLabel(`${color === "white" ? "White" : "Black"} · openai API key`);
      await expect(dialog.locator("input")).toHaveCount(1);
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute("type", "password");
      await input.fill("discarded-placeholder");
      await input.press("Escape");
      await expect(update).toBeFocused();
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await activate(update, touch);
      await expect(input).toHaveValue("");
      const replacement = fixtureKey();
      await input.fill(replacement);
      await activate(dialog.getByRole("button", { name: "Use keys for this page" }), touch);
      await expect(update).toBeFocused();
      await expect(retry).toHaveAttribute("aria-disabled", "false");
      await page.waitForTimeout(600);
      expect(turns).toHaveLength(count);
      expect(await readSnapshot(page, snapshot.gameId)).toEqual(paused);
      const storage = await page.evaluate(() => [
        JSON.stringify(localStorage),
        JSON.stringify(sessionStorage),
      ]);
      for (const key of [failed.key, other.key, replacement]) {
        expect(JSON.stringify(storage).includes(key)).toBe(false);
      }
      await retry.focus();
      await retry.press("Enter");
      await expect
        .poll(async () => (await readSnapshot(page, snapshot.gameId)).moves.length)
        .toBe(paused.moves.length + 1);
      await expect(retry).toBeFocused();
      const corrected = await readSnapshot(page, snapshot.gameId);
      expect(corrected.state).toBe("paused");
      expect(turns.at(-1)?.credential).toEqual({ provider: "openai", apiKey: replacement });
      expect(turns.at(-1)?.commandId).not.toBe(turns.at(-2)?.commandId);
      expect(turns.at(-1)?.expectedVersion).toBe(paused.version);
      // The creation configuration stays independent of the page-memory replacement.
      expect(configuration.mode).toBe(mode);
      if (mode === "ai_vs_ai" && color === "white") {
        await activate(page.getByRole("button", { name: "Next move", exact: true }), touch);
        await expect.poll(() => turns.length).toBe(count + 2);
        expect(turns.at(-1)?.credential).toEqual({ provider: other.provider, apiKey: other.key });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width,
      );
    });
  }
}
