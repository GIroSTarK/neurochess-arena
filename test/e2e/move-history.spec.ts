import { API_ORIGIN } from "./environment";
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
        const { i18n } = await import(/* @vite-ignore */ modulePath);
        i18n.addResourceBundle("en-XA", "translation", {
          game: {
            submitting: "Submitting your move… Waiting for confirmation from the chess server.",
            synchronizing:
              "Checking the accepted position… Waiting for the chess server to return the complete confirmed position and move history.",
            pendingHint:
              "You can still inspect the board while the move is confirmed. New moves will be available after confirmation.",
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
}
