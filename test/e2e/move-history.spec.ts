import { gameSnapshotSchema } from "@neurochess/contracts";

import type * as webI18n from "../../apps/web/src/i18n";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { acceptedMove, activate, expect, square, startSandbox, test } from "./fixtures";

for (const enlarged of [false, true]) {
  test(`keeps move history in place while moves are submitted and accepted${enlarged ? " with enlarged translations" : ""}`, async ({
    page,
  }, testInfo) => {
    const touch = testInfo.project.name === "mobile-touch";
    let current = await startSandbox(page, touch);
    if (enlarged) {
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      // Exercise wrapping without adding a product locale or a fixed-height fixture.
      await page.evaluate(async () => {
        const modulePath = "/src/i18n/index.ts";
        const { i18n } = (await import(/* @vite-ignore */ modulePath)) as typeof webI18n;
        i18n.addResourceBundle("en-XA", "translation", {
          game: {
            submitting: "Submitting your move… Waiting for confirmation from the chess server.",
            synchronizing:
              "Checking the accepted position… Waiting for the chess server to return the complete confirmed position and move history.",
          },
        });
        await i18n.changeLanguage("en-XA");
      });
    }
    const history = page.getByRole("region", { name: "Moves", exact: true });
    const historyTop = () =>
      history.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    const submitting = page.getByRole("paragraph").filter({ hasText: /^Submitting your move…/ });
    await expect(submitting).toHaveCount(0);

    for (const move of ["e2e4", "e7e5", "g1f3"]) {
      // Hold the real API response to expose the submitting frame reliably.
      const release = Promise.withResolvers<void>();
      const moveUrl = API_ORIGIN + "/games/" + current.gameId + "/moves";
      await page.route(moveUrl, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch();
        await release.promise;
        await route.fulfill({ response });
      });

      await activate(square(page, move.slice(0, 2)), touch);
      const before = await historyTop();
      if (move === "e2e4") {
        await page.screenshot({ path: testInfo.outputPath("move-ready.png"), fullPage: true });
      }
      const response = page.waitForResponse(
        (response) => response.url() === moveUrl && response.request().method() === "POST",
      );
      try {
        await activate(square(page, move.slice(2, 4)), touch);
        await expect(submitting).toBeVisible();
        await expect(page.getByText(/^Checking the accepted position…/)).not.toBeVisible();
        await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
        await expect(history).toContainText(
          current.moves.length + (current.moves.length === 1 ? " ply" : " plies"),
        );
        if (move === "e2e4") {
          await page.screenshot({ path: testInfo.outputPath("move-pending.png"), fullPage: true });
        }
        expect
          .soft(Math.abs((await historyTop()) - before), "History shifted during submission")
          .toBeLessThan(1);
      } finally {
        release.resolve();
      }
      current = await acceptedMove(await response, current, move, page);
      await expect(submitting).toHaveCount(0);
      expect
        .soft(Math.abs((await historyTop()) - before), "History shifted after acceptance")
        .toBeLessThan(1);
      await page.unroute(moveUrl);
    }
    await page.screenshot({ path: testInfo.outputPath("move-accepted.png"), fullPage: true });
  });

  test(`reveals the selected SAN in long replays without moving page scroll or focus${enlarged ? " with enlarged text" : ""}`, async ({
    page,
  }, testInfo) => {
    const touch = testInfo.project.name === "mobile-touch";
    let current = await startSandbox(page, touch);
    const initialFen = current.fen;
    // Build a long history through real commands; this test exercises replay navigation, not move entry.
    const moves = [
      "a2a3 a7a6 b2b3 b7b6 c2c3 c7c6 d2d3 d7d6 e2e3 e7e6 f2f3 f7f6 g2g3 g7g6 h2h3 h7h6",
      "a3a4 a6a5 b3b4 b6b5 c3c4 c6c5 d3d4 d6d5 e3e4 e6e5 f3f4 f6f5 g3g4 g6g5 h3h4 h6h5",
    ]
      .join(" ")
      .split(" ");
    for (const move of moves) {
      const response = await page.request.post(API_ORIGIN + "/games/" + current.gameId + "/moves", {
        headers: { Origin: WEB_ORIGIN },
        data: {
          gameId: current.gameId,
          move,
          expectedVersion: current.version,
          commandId: crypto.randomUUID(),
        },
      });
      expect(response.status()).toBe(200);
      current = gameSnapshotSchema.parse(await response.json());
    }
    await page.reload();
    await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
    await activate(page.getByRole("button", { name: "Abort game", exact: true }), touch);
    await activate(
      page.getByRole("dialog").getByRole("button", { name: "Stop game", exact: true }),
      touch,
    );
    await expect(page.getByRole("heading", { name: "Game stopped" })).toBeVisible();
    await expect(page.getByRole("button", { name: "First", exact: true })).toBeEnabled();
    if (enlarged) await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const history = page.getByRole("region", { name: "Move history", exact: true });
    const scrollTop = () => history.evaluate((element) => element.scrollTop);
    expect(await history.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );

    async function navigate(name: string, ply: number) {
      const control = page.getByRole("button", { name, exact: true });
      await control.focus();
      const pageScroll = await page.evaluate(() => window.scrollY);
      await page.keyboard.press("Enter");
      await expect(control).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
      await expect(page.getByRole("grid")).toHaveAttribute(
        "data-fen",
        ply === 0 ? initialFen : current.moves[ply - 1]!.fen,
      );
      if (ply === 0) {
        expect(await scrollTop()).toBe(0);
        await expect(history.locator('[aria-current="step"]')).toHaveCount(0);
        return;
      }
      const selected = history.getByRole("button", { name: new RegExp("^View ply " + ply + ":") });
      await expect(selected).toHaveAttribute("aria-current", "step");
      const bounds = await selected.evaluate((element) => {
        const panel = element.closest('[role="region"]')!;
        const head = panel.querySelector("thead")!.getBoundingClientRect();
        const selection = element.getBoundingClientRect();
        const viewport = panel.getBoundingClientRect();
        return {
          top: selection.top,
          bottom: selection.bottom,
          visibleTop: head.bottom,
          visibleBottom: viewport.top + panel.clientTop + panel.clientHeight,
        };
      });
      expect(bounds.top).toBeGreaterThanOrEqual(bounds.visibleTop - 1);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.visibleBottom + 1);
    }

    await navigate("First", 0);
    await navigate("Next", 1);
    await navigate("Last", moves.length);
    const atEnd = await scrollTop();
    await navigate("Previous", moves.length - 1);
    expect(await scrollTop()).toBe(atEnd);
    for (let ply = moves.length - 2; ply >= 15; ply -= 1) await navigate("Previous", ply);
    const visible = await scrollTop();
    await navigate("Next", 16);
    expect(await scrollTop()).toBe(visible);
    await page.screenshot({ path: testInfo.outputPath("replay-selected.png"), fullPage: true });

    // Inspecting other rows and unrelated renders must not continually pull the list back.
    await history.evaluate((element) => {
      element.scrollTop = 0;
    });
    await activate(page.getByRole("button", { name: "Flip board", exact: true }), touch);
    expect(await scrollTop()).toBe(0);
    await navigate("Last", moves.length);
    await navigate("First", 0);
  });
}
