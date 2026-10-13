import { activate, expect, startSandbox, test } from "./fixtures";

for (const adapter of ["sandbox", "reference"] as const) {
  test(`${adapter} preserves board inspection and keyboard order through live and replay`, async ({
    page,
  }, testInfo) => {
    const touch = Boolean(testInfo.project.use.hasTouch);
    if (adapter === "sandbox") {
      await startSandbox(page, touch);
    } else {
      await page.goto("/dev/arena");
      await expect(page).toHaveTitle("Arena test scenarios · Neurochess Arena");
      await page.getByLabel("Test scenario").selectOption("aiHuman");
    }
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const board = page.getByRole("grid", { name: "Chessboard" });
    const fen = await board.getAttribute("data-fen");
    const flip = page.getByRole("button", { name: "Flip board" });
    const help = page.getByRole("button", { name: "Keyboard controls" });
    const instructions = page.getByText(/^Use arrow keys to inspect squares\./);
    await expect(flip).toHaveAccessibleDescription("White at bottom");
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await expect(instructions).toBeHidden();
    await expect(board).toHaveAttribute(
      "aria-describedby",
      (await help.getAttribute("aria-controls"))!,
    );
    await expect(board).toHaveAccessibleDescription(/^Use arrow keys to inspect squares\./);

    await page.getByRole("button", { name: "Pause", exact: true }).focus();
    const resignations =
      adapter === "sandbox" ? ["Resign White", "Resign Black"] : ["Resign White"];
    for (const name of ["Flip board", ...resignations, "Keyboard controls", "Abort game"]) {
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
    }
    await flip.focus();
    await page.keyboard.press("Enter");
    await expect(flip).toBeFocused();
    await expect(flip).toHaveAccessibleDescription("Black at bottom");
    await expect(board).toHaveAttribute("data-orientation", "black");
    await expect(board).toHaveAttribute("data-fen", fen!);
    await help.focus();
    await page.keyboard.press("Space");
    await expect(help).toBeFocused();
    await expect(help).toHaveAttribute("aria-expanded", "true");
    await expect(instructions).toBeVisible();
    await activate(flip, touch);
    await expect(flip).toHaveAccessibleDescription("White at bottom");
    await expect(instructions).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("live-inspection.png"), fullPage: true });

    await activate(page.getByRole("button", { name: "Abort game" }), touch);
    await activate(page.getByRole("dialog").getByRole("button", { name: "Stop game" }), touch);
    await expect(page.getByRole("heading", { name: "Game stopped" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Replay", exact: true })).toBeVisible();
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await expect(instructions).toBeHidden();
    await expect(board).toHaveAttribute(
      "aria-describedby",
      (await help.getAttribute("aria-controls"))!,
    );
    await expect(board).toHaveAccessibleDescription(/^Use arrow keys to inspect squares\./);
    await page.getByRole("button", { name: "Last", exact: true }).focus();
    const exportActions = adapter === "sandbox" ? ["Copy PGN", "Download PGN"] : [];
    for (const name of [...exportActions, "Flip board", "Keyboard controls"]) {
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(help).toHaveAttribute("aria-expanded", "true");
    await expect(instructions).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(flip).toBeFocused();
    await page.keyboard.press("Space");
    await expect(flip).toBeFocused();
    await expect(flip).toHaveAccessibleDescription("Black at bottom");
    await expect(board).toHaveAttribute("data-orientation", "black");
    await expect(board).toHaveAttribute("data-fen", fen!);
    await expect(instructions).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("replay-inspection.png"), fullPage: true });
    await page.keyboard.press("Tab");
    await expect(help).toBeFocused();
    await page.keyboard.press("Space");
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await expect(instructions).toBeHidden();
  });
}
