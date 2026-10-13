import {
  acceptedMove,
  expect,
  playMove,
  readSnapshot,
  square,
  startSandbox,
  test,
} from "./fixtures";
import { expectRenderedContrast } from "./rendered-contrast";

for (const scenario of [
  {
    name: "castling",
    approach: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"],
    source: "e1",
    destination: "g1",
    keys: ["ArrowRight", "ArrowRight"],
    move: "e1g1",
    san: "O-O",
    pieces: [
      ["g1", "white-k"],
      ["f1", "white-r"],
    ],
    empty: ["e1", "h1"],
  },
  {
    name: "en passant",
    approach: ["e2e4", "a7a6", "e4e5", "d7d5"],
    source: "e5",
    destination: "d6",
    keys: ["ArrowLeft", "ArrowUp"],
    move: "e5d6",
    san: "exd6",
    pieces: [["d6", "white-p"]],
    empty: ["e5", "d5"],
  },
] as const) {
  test(`submits ${scenario.name} by keyboard and renders only the accepted piece changes`, async ({
    page,
  }, testInfo) => {
    const touch = Boolean(testInfo.project.use.hasTouch);
    let current = await startSandbox(page, touch);
    for (const move of scenario.approach) current = await playMove(page, current, move, touch);
    expect(current.legalMoves).toContain(scenario.move);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await square(page, scenario.source).focus();
    await page.keyboard.press("Space");
    await expect(square(page, scenario.source)).toHaveAttribute("data-selected", "true");
    await expect(square(page, scenario.destination)).toHaveAttribute(
      "data-target",
      scenario.name === "en passant" ? "capture" : "move",
    );
    if (scenario.name === "en passant") {
      await expect(square(page, scenario.destination)).toHaveAccessibleName(
        /Legal en passant capture/,
      );
    }
    await expectRenderedContrast(page);
    for (const key of scenario.keys) await page.keyboard.press(key);
    await expect(square(page, scenario.destination)).toBeFocused();
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/games/" + current.gameId + "/moves"),
    );
    await page.keyboard.press("Enter");
    current = await acceptedMove(await response, current, scenario.move, page);
    await expect(square(page, scenario.destination)).toBeFocused();
    for (const [coordinate, piece] of scenario.pieces) {
      await expect(square(page, coordinate).locator(`[data-piece="${piece}"]`)).toHaveCount(1);
    }
    for (const coordinate of scenario.empty) {
      await expect(square(page, coordinate).locator("[data-piece]")).toHaveCount(0);
    }
    await expect(page.getByRole("region", { name: "Moves", exact: true })).toContainText(
      scenario.san,
    );
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", current.fen);
    expect(await readSnapshot(page, current.gameId)).toEqual(current);
    await expectRenderedContrast(page);
    await page.screenshot({
      path: testInfo.outputPath(`keyboard-${scenario.name.replaceAll(" ", "-")}.png`),
      fullPage: true,
    });
  });
}
