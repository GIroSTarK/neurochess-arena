import { gameSnapshotSchema } from "@neurochess/contracts";

import type * as webI18n from "../../apps/web/src/i18n";

import { expectArenaLayout, expectArenaTransition } from "./arena-layout";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { acceptedMove, activate, expect, playMove, square, startSandbox, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

const longGameMoves = [
  "a2a3 a7a6 b2b3 b7b6 c2c3 c7c6 d2d3 d7d6 e2e3 e7e6 f2f3 f7f6 g2g3 g7g6 h2h3 h7h6",
  "a3a4 a6a5 b3b4 b6b5 c3c4 c6c5 d3d4 d6d5 e3e4 e6e5 f3f4 f6f5 g3g4 g6g5 h3h4 h6h5",
  // A 640px board leaves enough rail space for the original 32 plies; keep scroll tests overflowing.
  "b1c3 b8c6 g1f3 g8f6 d1c2 d8c7 c1e3 c8e6 f1d3 f8d6 e1c1 e8c8 h1e1 h8e8 d3e2 d6e7",
]
  .join(" ")
  .split(" ");

test("uses available rail height without letting move rows grow the arena", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  let current = await startSandbox(page, touch);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const history = page.getByRole("region", { name: "Move history", exact: true });
  const arena = page.getByTestId("arena-frame");
  const arenaHeight = () => arena.evaluate((element) => element.getBoundingClientRect().height);
  const initialHeight = await arenaHeight();
  const playArea = page.getByRole("region", { name: "Play area", exact: true });
  const playHeight = () => playArea.evaluate((element) => element.getBoundingClientRect().height);
  const initialPlayHeight = await playHeight();

  async function checkRailHeight() {
    const layout = await history.evaluate((element) => {
      const rail = element.closest("aside")!;
      const play = rail.previousElementSibling!;
      const supporting = rail.lastElementChild!;
      return {
        railHeight: rail.getBoundingClientRect().height,
        playHeight: play.getBoundingClientRect().height,
        railBottom: rail.getBoundingClientRect().bottom,
        supportingBottom: supporting.getBoundingClientRect().bottom,
        scrollHeight: element.scrollHeight,
        height: element.clientHeight,
      };
    });
    expect(layout.railHeight).toBeCloseTo(layout.playHeight, 0);
    expect(layout.supportingBottom).toBeCloseTo(layout.railBottom, 0);
    return layout;
  }

  for (const move of longGameMoves.slice(0, 24)) {
    current = await playMove(page, current, move, touch);
  }
  expect(await playHeight()).toBeCloseTo(initialPlayHeight, 0);
  if (!touch) {
    expect(await arenaHeight()).toBeCloseTo(initialHeight, 0);
    const layout = await checkRailHeight();
    expect(layout.height).toBeGreaterThan(448);
    expect(layout.scrollHeight).toBe(layout.height);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("history-24-plies.png"), fullPage: true });

  for (const move of longGameMoves.slice(24)) {
    current = await playMove(page, current, move, touch);
  }
  expect(await playHeight()).toBeCloseTo(initialPlayHeight, 0);
  expect(await history.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  if (!touch) {
    expect(await arenaHeight()).toBeCloseTo(initialHeight, 0);
    const transition = await expectArenaTransition(page);
    for (const width of [transition, 1440]) {
      await page.setViewportSize({ width, height: 1080 });
      await checkRailHeight();
    }
    const beforeHelp = await history.evaluate((element) => element.clientHeight);
    await page.getByRole("button", { name: "Keyboard controls", exact: true }).click();
    await expect
      .poll(() => history.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(beforeHelp);
    await checkRailHeight();
  }
});

test("scrolls the page with empty and short move histories", async ({
  page,
  browserName,
  isMobile,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  await page.setViewportSize({ width: touch ? 390 : 1440, height: 500 });
  let current = await startSandbox(page, touch);
  const history = page.getByRole("region", { name: "Move history", exact: true });

  async function scrollPageOverHistory() {
    expect(await history.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
      true,
    );
    await history.hover();
    const before = await page.evaluate(() => window.scrollY);
    const direction = before > 50 ? -1 : 1;
    if (browserName === "webkit" && isMobile) {
      await page.keyboard.press(direction < 0 ? "PageUp" : "PageDown");
    } else {
      await page.mouse.wheel(0, direction * 200);
    }
    await expect
      .poll(async () => ((await page.evaluate(() => window.scrollY)) - before) * direction)
      .toBeGreaterThan(50);
    expect(await history.evaluate((element) => element.scrollTop)).toBe(0);
  }

  await scrollPageOverHistory();
  for (const move of ["e2e4", "e7e5", "g1f3"]) current = await playMove(page, current, move, touch);
  await scrollPageOverHistory();
});

for (const longHistory of [false, true]) {
  test(`keeps ${longHistory ? "long" : "short"} history readable after an uncertain Resume with enlarged translations`, async ({
    page,
  }, testInfo) => {
    const touch = Boolean(testInfo.project.use.hasTouch);
    let current = await startSandbox(page, touch);
    // Populate through real commands; only the Resume acknowledgement is replaced below.
    for (const move of longHistory ? longGameMoves : ["f2f3", "e7e5", "g2g4"]) {
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
    const resume = page.getByRole("button", { name: /^Resume/ });
    await expect(resume).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByRole("heading", { name: /^Game recovered/ })).toBeVisible();
    await setPseudoLocalization(page, true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });

    const commandUrl = API_ORIGIN + "/games/" + current.gameId + "/lifecycle";
    await page.route(commandUrl, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await activate(resume, touch);
    const retry = page.getByRole("button", { name: /^Retry same command/ });
    await expect(retry).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Game recovered/ })).toHaveCount(0);
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", current.fen);
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");

    const history = page.getByRole("region", { name: /^Move history/ });
    for (const width of touch ? [390, 1024] : [1025, 1100, 1440]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.evaluate(() => document.fonts.ready);
      const layout = await history.evaluate((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        header: element.querySelector("thead")!.getBoundingClientRect().height,
        row: element.querySelector("tbody tr")!.getBoundingClientRect().height,
        bottom: element.getBoundingClientRect().bottom,
        supportingTop: element.closest("aside")!.lastElementChild!.getBoundingClientRect().top,
      }));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: testInfo.outputPath(`uncertain-resume-${width}.png`),
        fullPage: true,
      });
      expect(
        layout.height,
        "History must show the sticky header and a complete move row",
      ).toBeGreaterThan(layout.header + layout.row);
      expect(layout.bottom).toBeLessThan(layout.supportingTop);
      await expectArenaLayout(page);
      if (longHistory) {
        expect(layout.scrollHeight).toBeGreaterThan(layout.height);
        await history.focus();
        for (const key of ["Home", "End"]) {
          // Keyboard scrolling animates, and Chromium can drop a key pressed before it ends.
          const scrolled = history.evaluate(
            (element) =>
              new Promise<void>((resolve) => {
                element.addEventListener("scrollend", () => resolve(), { once: true });
                setTimeout(resolve, 2_000);
              }),
          );
          await page.keyboard.press(key);
          await scrolled;
          const rows = history.locator("tbody tr");
          const row = key === "Home" ? rows.first() : rows.last();
          await expect
            .poll(() =>
              row.evaluate((element) => {
                const panel = element.closest('[role="region"]')!;
                const header = panel.querySelector("thead")!.getBoundingClientRect();
                const bounds = element.getBoundingClientRect();
                return (
                  bounds.top >= header.bottom - 1 &&
                  bounds.bottom <= panel.getBoundingClientRect().bottom + 1
                );
              }),
            )
            .toBe(true);
          await expect(history).toBeFocused();
        }
      }
    }
    await page.unroute(commandUrl);
    await activate(retry, touch);
    await expect(page.getByRole("button", { name: /^Pause/ })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await expect(page.getByRole("grid")).toHaveAttribute("data-fen", current.fen);
    await expect(retry).toHaveCount(0);
  });
}

for (const enlarged of [false, true]) {
  test(`keeps move history in place while moves are submitted and accepted${enlarged ? " with enlarged translations" : ""}`, async ({
    page,
  }, testInfo) => {
    const touch = Boolean(testInfo.project.use.hasTouch);
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
    browserName,
    isMobile,
  }, testInfo) => {
    const touch = Boolean(testInfo.project.use.hasTouch);
    let current = await startSandbox(page, touch);
    const initialFen = current.fen;
    // Build a long history through real commands; this test exercises replay navigation, not move entry.
    const moves = longGameMoves;
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
    // WebKit can apply focus scrolling in the next rendering update, so read settled positions.
    const settledPageScroll = () =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY))),
          ),
      );
    expect(await history.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await history.hover();
    const middle = await history.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
      return element.scrollTop;
    });
    if (browserName === "webkit" && isMobile) {
      await history.focus();
      await expect(history).toBeFocused();
    }
    const pageBeforeWheel = await settledPageScroll();
    if (browserName === "webkit" && isMobile) {
      await page.keyboard.press("ArrowUp");
    } else {
      await page.mouse.wheel(0, -Math.min(40, middle / 2));
    }
    await expect.poll(scrollTop).toBeLessThan(middle);
    expect(await settledPageScroll()).toBe(pageBeforeWheel);

    async function navigate(name: string, ply: number) {
      const control = page.getByRole("button", { name, exact: true });
      await control.focus();
      const pageScroll = await settledPageScroll();
      await page.keyboard.press("Enter");
      await expect(control).toBeFocused();
      expect(await settledPageScroll()).toBe(pageScroll);
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
