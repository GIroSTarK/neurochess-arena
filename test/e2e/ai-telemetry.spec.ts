import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { gameSnapshotSchema } from "@neurochess/contracts";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { activate, expect, readSnapshot, square, test } from "./fixtures";

for (const mode of ["ai_vs_ai", "ai_vs_human"] as const) {
  test(`${mode} displays private attempts and move telemetry consistently through replay and PGN`, async ({
    page,
    context,
  }, info) => {
    const touch = info.project.name === "mobile-touch";
    await page.goto("/");
    const key = `fixture-telemetry-${randomUUID()}`;
    if (mode === "ai_vs_human") {
      await page.getByRole("radio", { name: /AI vs human/ }).check();
      await page
        .getByRole("group", { name: "Your color" })
        .getByRole("radio", { name: "Black", exact: true })
        .check();
    }
    for (const color of mode === "ai_vs_ai" ? ["White", "Black"] : ["White"]) {
      const panel = page.getByRole("region", { name: `${color} configuration` });
      const provider = panel.getByRole("combobox", { name: "Provider" });
      await expect(provider).toHaveAttribute("aria-disabled", "false");
      await provider.selectOption(color === "White" ? "openai" : "anthropic");
      await panel.getByLabel("API key", { exact: true }).fill(key);
      await panel.getByRole("button", { name: "Load models" }).click();
      const picker = panel.getByRole("combobox", { name: "Model", exact: true });
      await picker.fill("Fixture full");
      await picker.press("ArrowDown");
      await picker.press("Enter");
    }
    const creation = page.waitForResponse(
      (response) => response.url() === API_ORIGIN + "/ai/games",
    );
    await page.getByRole("button", { name: "Start game" }).click();
    const initial = gameSnapshotSchema.parse(await (await creation).json());
    await expect(page).toHaveTitle(
      `${mode === "ai_vs_ai" ? "AI vs AI" : "AI vs human"} · Neurochess Arena`,
    );
    await expect(page).toHaveURL(WEB_ORIGIN + "/");
    await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await expect(
      page.getByText("Provider quota or rate limit reached", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Illegal move response", { exact: true })).toBeVisible();
    expect((await readSnapshot(page, initial.gameId)).state).toBe("paused");
    const retry = page.getByRole("button", {
      name: "Retry move",
      exact: true,
    });
    await expect(retry).toHaveAttribute("aria-disabled", "false");
    await activate(retry, touch);
    const details = page.getByRole("article", { name: "Details for ply 1" });
    await expect(details.getByText("125 ms", { exact: true })).toBeVisible();
    await expect(details.getByText("0", { exact: true })).toBeVisible();
    await expect(details.getByText("7", { exact: true })).toBeVisible();
    await expect(details.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(
      details.getByText('<img src=x onerror="alert(1)"> Controls the center.', { exact: true }),
    ).toBeVisible();
    await expect(page.locator("main img")).toHaveCount(0);
    const retried = page
      .locator("details")
      .filter({ has: page.getByText("Ply 1 · White · Attempt 3", { exact: true }) });
    await retried.locator("summary").focus();
    await retried.locator("summary").press("Enter");
    await expect(retried).toHaveAttribute("open", "");
    await expect(retried.getByText("125 ms")).toBeVisible();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    if (mode === "ai_vs_ai") {
      await page.getByRole("combobox", { name: "Playback speed" }).selectOption("2");
    } else {
      for (const move of ["e7e5", "d8h4"]) {
        await expect(
          page.getByText("Your turn. Choose a move on the board.", { exact: true }),
        ).toBeVisible();
        for (const coordinate of [move.slice(0, 2), move.slice(2, 4)]) {
          await activate(square(page, coordinate), touch);
        }
      }
    }
    await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
    const terminal = await readSnapshot(page, initial.gameId);
    expect(terminal.moves.map((move) => move.uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);
    expect(terminal.invocations?.slice(0, 3).map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    await expect(page.getByRole("button", { name: "First", exact: true })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await activate(page.getByRole("button", { name: "First", exact: true }), touch);
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", initial.fen);
    await expect(page.getByText("Initial position. No move selected.")).toBeVisible();
    for (const move of terminal.moves) {
      await activate(
        page.getByRole("button", { name: `View ply ${move.ply}: ${move.san}`, exact: true }),
        touch,
      );
      await expect(page.getByRole("grid")).toHaveAttribute("data-fen", move.fen);
      if (mode === "ai_vs_human" && move.ply % 2 === 0) {
        await expect(page.getByText("Human move. No model telemetry.")).toBeVisible();
        await expect(page.getByRole("article")).toHaveCount(0);
      } else {
        const selected = page.getByRole("article", { name: `Details for ply ${move.ply}` });
        await expect(selected.getByText(`${move.ply * 125} ms`)).toBeVisible();
        if (move.ply !== 1) {
          await expect(selected.getByText("No commentary provided")).toBeVisible();
        }
      }
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB_ORIGIN });
    await page.getByRole("button", { name: "Copy PGN", exact: true }).click();
    await expect(page.getByText("PGN copied.", { exact: true }).first()).toBeVisible();
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n"),
    ).toBe(terminal.pgn);
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PGN", exact: true }).click();
    expect(await readFile(await (await downloading).path(), "utf8")).toBe(terminal.pgn);
    await expect(page.getByRole("button", { name: "First", exact: true })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await activate(page.getByRole("button", { name: "View ply 1: f3", exact: true }), touch);
    await expect(details.getByText("125 ms", { exact: true })).toBeVisible();
    expect(await readSnapshot(page, initial.gameId)).toEqual(terminal);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 0,
    );
    await page.screenshot({
      path: join(tmpdir(), `neurochess-telemetry-${mode}-${info.project.name}.png`),
      fullPage: true,
    });
  });
}
