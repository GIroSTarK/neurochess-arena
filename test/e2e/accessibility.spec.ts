import { text } from "node:stream/consumers";

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { expectArenaLayout } from "./arena-layout";
import { activate, expect, square, startSandbox, test } from "./fixtures";
import { expectRenderedContrast } from "./rendered-contrast";
import { setPseudoLocalization } from "./text-layout";

async function tabTo(page: Page, target: Locator) {
  await page.bringToFront();
  await expect(target).toBeVisible();
  let backwards = false;
  for (let step = 0; step < 100; step++) {
    const focus = await target.evaluate((element) => {
      const active = document.activeElement;
      return {
        reached: active === element,
        backwards:
          !active || active === document.body || active === document.documentElement
            ? null
            : Boolean(element.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    if (focus.reached) return;
    // Body is a transient native traversal boundary; keep the previous direction through it.
    backwards = focus.backwards ?? backwards;
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
  }
  await expect(target).toBeFocused();
}

async function enter(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}

test("keyboard account, setup, key recovery, replay, export and history form one usable journey", async ({
  page,
  newContext,
}, testInfo) => {
  const seed = await newContext();
  const account = await createAccount(seed.request);
  await seed.close();
  await page.goto("/auth/sign-in");
  await enter(page, page.getByRole("button", { name: "Sign in", exact: true }));
  await expect(page.getByRole("alert")).toHaveText("Enter a valid email address.");
  await expect(page.getByLabel("Email", { exact: true })).toHaveAccessibleDescription(
    "Enter a valid email address.",
  );
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeFocused();
  await expectRenderedContrast(page);
  await tabTo(page, page.getByLabel("Email", { exact: true }));
  await page.keyboard.insertText(account.email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.insertText(account.password);
  await enter(page, page.getByRole("button", { name: "Sign in", exact: true }));
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();

  await tabTo(page, page.getByLabel("Game mode"));
  await page.keyboard.press("End");
  await expect(page.getByLabel("Game mode")).toHaveValue("ai_vs_human");
  const seat = page.getByRole("group", { name: "Black", exact: true });
  await tabTo(page, seat.getByLabel("API key", { exact: true }));
  await page.keyboard.insertText("match-fixture");
  await enter(page, seat.getByRole("button", { name: "Load models", exact: true }));
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await tabTo(page, model);
  await page.keyboard.insertText("model-a");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(model).toHaveValue("Model A (test fixture)");
  await enter(page, page.getByRole("button", { name: "Start game", exact: true }));
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await page.reload();
  const key = page.getByLabel("Black · OpenAI · API key", { exact: true });
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await enter(page, resume);
  await expect(resume).toHaveAttribute("aria-disabled", "true");
  await expect(resume).toBeFocused();
  await expectRenderedContrast(page);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await enter(page, page.getByRole("button", { name: "Restore keys", exact: true }));
  await expect(key).toBeVisible();
  await tabTo(page, key);
  await page.keyboard.insertText("match-fixture");
  await enter(page, page.getByRole("button", { name: "Keep paused", exact: true }));
  await enter(page, resume);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const turn = Promise.withResolvers<void>();
  await page.route("**/ai-turn", async (route) => {
    await turn.promise;
    await route.continue();
  });
  await tabTo(page, page.locator('[data-square][tabindex="0"]'));
  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await expect(square(page, "f2")).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  try {
    await expect(
      page.getByRole("heading", { name: "Black is choosing a move…", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.getAnimations().filter((animation) => animation.playState === "running")
              .length,
        ),
      )
      .toBe(0);
  } finally {
    turn.resolve();
  }
  await expect(page.getByRole("status")).toContainText("e5");
  await page.unroute("**/ai-turn");
  await expect(square(page, "f3")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
  ).toBeVisible();
  await expectRenderedContrast(page);

  await tabTo(page, page.getByRole("tab", { name: "Moves", exact: true }));
  await page.keyboard.press("ArrowRight");
  const commentary = page.getByRole("tab", { name: "Commentary", exact: true });
  if (await commentary.isVisible()) {
    await expect(commentary).toBeFocused();
    await page.keyboard.press("ArrowRight");
  }
  await expect(page.getByRole("tab", { name: "Analysis", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  const slider = page.getByRole("slider", { name: "Replay position", exact: true });
  await tabTo(page, slider);
  await page.keyboard.press("Home");
  await expect(slider).toHaveAttribute("aria-valuetext", /^Initial position · Ply 0 · /);
  await page.keyboard.press("End");
  await expect(slider).toHaveAttribute(
    "aria-valuetext",
    "Ply 4 · Qh4# · Black delivered checkmate",
  );
  await page.keyboard.press("Tab");
  const values = page.getByText("Evaluation values", { exact: true }).first();
  await expect(values).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("evaluation-marker")).toHaveAttribute("data-ply", "0");
  await expect(
    page.getByRole("table", { name: "Evaluation values" }).getByRole("button").first(),
  ).toBeFocused();
  await expectRenderedContrast(page);
  await page.screenshot({ path: testInfo.outputPath("keyboard-replay.png"), fullPage: true });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);

  const download = page.waitForEvent("download");
  await enter(page, page.getByRole("button", { name: "Download PGN", exact: true }));
  const stream = await (await download).createReadStream();
  expect(await text(stream)).toContain("1. f3 e5 2. g4 Qh4# 0-1");
  await expect(page.getByRole("button", { name: "Download PGN", exact: true })).toBeFocused();
  await enter(page, page.getByRole("link", { name: "History", exact: true }));
  await enter(page, page.getByRole("button", { name: /^Delete game ·/ }));
  const dialog = page.getByRole("dialog", { name: "Delete this game?" });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expectRenderedContrast(page);
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Delete game", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^Delete game ·/ })).toBeFocused();
  await enter(page, page.getByRole("link", { name: /^Open replay/ }));
  await expect(
    page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
  ).toBeVisible();
});

test("keyboard room entry, remote updates and confirmation preserve each participant's focus", async ({
  page,
  newContext,
}) => {
  await createAccount(page.request);
  await page.goto("/rooms");
  await enter(page, page.getByRole("button", { name: "Create room", exact: true }));
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  await tabTo(page, page.getByRole("textbox", { name: "Invitation link", exact: true }));
  const invitation = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  const peer = await (await newContext()).newPage();
  await peer.goto(invitation);
  await enter(peer, peer.getByRole("button", { name: "Join as guest", exact: true }));
  await expect(peer.getByTestId("room-connection")).toHaveText("Room connected");
  await tabTo(peer, peer.getByRole("button", { name: "Resign", exact: true }));
  await tabTo(page, page.locator('[data-square][tabindex="0"]'));
  await page.keyboard.press("Control+End");
  for (let index = 0; index < 3; index++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(peer.getByRole("status")).toContainText("e4");
  await expect(peer.getByRole("button", { name: "Resign", exact: true })).toBeFocused();
  await expect(square(page, "e4")).toBeFocused();
  await expect(peer.getByRole("status")).toHaveAttribute("aria-live", "polite");
  expect((await peer.getByRole("status").innerText()).length).toBeLessThan(250);
  await enter(peer, peer.getByRole("button", { name: "Resign", exact: true }));
  const dialog = peer.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await peer.keyboard.press("Escape");
  await expect(peer.getByRole("button", { name: "Resign", exact: true })).toBeFocused();
  await peer.keyboard.press("Enter");
  await enter(
    peer,
    peer.getByRole("dialog").getByRole("button", { name: "Confirm resignation", exact: true }),
  );
  for (const player of [page, peer]) {
    await expect(player.getByRole("heading", { name: "White wins", exact: true })).toBeVisible();
    await expect(player.getByRole("status")).toContainText("White wins by resignation");
    expect((await new AxeBuilder({ page: player }).analyze()).violations).toEqual([]);
  }
});

test("keyboard credential consent, reveal and revoke keep safe dialog focus", async ({ page }) => {
  await createAccount(page.request);
  await page.goto("/account/credentials");
  await enter(page, page.getByRole("button", { name: "Save key", exact: true }));
  await expect(page.getByRole("button", { name: "Save key", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await tabTo(page, page.getByLabel("Label", { exact: true }));
  await page.keyboard.insertText("Keyboard fixture");
  await page.keyboard.press("Tab");
  const key = page.getByLabel("API key", { exact: true });
  await expect(key).toBeFocused();
  await page.keyboard.insertText("match-fixture");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Show key", exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(key).toHaveAttribute("type", "text");
  await page.keyboard.press("Space");
  await expect(key).toHaveAttribute("type", "password");
  await page.keyboard.press("Tab");
  const consent = page.getByRole("checkbox", { name: "Save this key to my account" });
  await expect(consent).toBeFocused();
  await page.keyboard.press("Space");
  await enter(page, page.getByRole("button", { name: "Save key", exact: true }));
  await expect(page.getByText("Keyboard fixture", { exact: true })).toBeVisible();
  await expect(key).toHaveValue("");
  await enter(page, page.getByRole("button", { name: "Revoke Keyboard fixture" }));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Revoke key", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Revoke Keyboard fixture" })).toBeFocused();
  await page.keyboard.press("Enter");
  await enter(
    page,
    page.getByRole("dialog").getByRole("button", { name: "Revoke key", exact: true }),
  );
  await expect(page.getByRole("heading", { name: "Your saved keys", exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("keeps keyboard-focused squares in view on short viewports in both orientations", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  await page.setViewportSize(touch ? { width: 390, height: 400 } : { width: 1280, height: 600 });
  await startSandbox(page, touch);

  async function navigateTo(key: string, coordinate: string) {
    await page.keyboard.press(key);
    const destination = square(page, coordinate);
    await expect(destination).toBeFocused();
    // Native focus scrolling rounds fractional square bounds to CSS pixels.
    await expect
      .poll(() =>
        destination.evaluate((element) => {
          const { top, right, bottom, left } = element.getBoundingClientRect();
          return Math.max(-top, -left, bottom - window.innerHeight, right - window.innerWidth);
        }),
      )
      .toBeLessThanOrEqual(1);
  }

  for (const orientation of ["white", "black"] as const) {
    if (orientation === "black") {
      await activate(page.getByRole("button", { name: "Flip board" }), touch);
    }
    await expect(page.getByRole("grid")).toHaveAttribute("data-orientation", orientation);
    const leftFile = orientation === "white" ? "a" : "h";
    const rightFile = orientation === "white" ? "h" : "a";
    const ranks =
      orientation === "white"
        ? ([1, 2, 3, 4, 5, 6, 7, 8] as const)
        : ([8, 7, 6, 5, 4, 3, 2, 1] as const);
    const first = leftFile + ranks[7];
    const last = rightFile + ranks[0];

    await activate(square(page, last), touch);
    // Seed an offscreen destination independently of the engine's native focus alignment.
    await square(page, last).evaluate((element) => element.scrollIntoView({ block: "start" }));
    await expect(square(page, first)).not.toBeInViewport();
    await navigateTo("Control+Home", first);
    await navigateTo("End", rightFile + ranks[7]);
    await navigateTo("Control+End", last);
    await navigateTo("Home", leftFile + ranks[0]);
    for (const rank of ranks.slice(1)) await navigateTo("ArrowUp", leftFile + rank);
    for (const rank of ranks.toReversed().slice(1)) await navigateTo("ArrowDown", leftFile + rank);
  }
});

test("supports keyboard inspection in both orientations, reflow, and enlarged localized text", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  await startSandbox(page, touch);
  await square(page, "e2").focus();
  await page.keyboard.press("Enter");
  await expect(square(page, "e2")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(square(page, "e3")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(square(page, "e2")).not.toHaveAttribute("data-selected");
  await page.keyboard.press("Control+Home");
  await expect(square(page, "a8")).toBeFocused();
  await page.keyboard.press("Control+End");
  await expect(square(page, "h1")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Flip board" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("grid")).toHaveAttribute("data-orientation", "black");
  await expect(square(page, "h1")).toHaveAttribute("tabindex", "0");
  await square(page, "e2").focus();
  await page.keyboard.press("ArrowRight");
  await expect(square(page, "d2")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(square(page, "d3")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(square(page, "h3")).toBeFocused();
  await page.keyboard.press("End");
  await expect(square(page, "a3")).toBeFocused();
  const focus = await square(page, "a3").evaluate((element) => {
    const frame = element.closest("[data-testid=arena-frame]");
    return {
      keyline: getComputedStyle(element).boxShadow,
      clip: frame ? getComputedStyle(frame).clipPath : null,
    };
  });
  expect(focus.keyline).not.toBe("none");
  expect(focus.clip).toBe("none");
  expect(
    await page
      .locator("[data-square]")
      .evaluateAll(
        (squares) => squares.filter((element) => (element as HTMLElement).tabIndex === 0).length,
      ),
  ).toBe(1);
  await activate(page.getByRole("button", { name: "Flip board" }), touch);
  for (const width of touch ? [320, 390] : [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectArenaLayout(page);
    await page.screenshot({
      path: testInfo.outputPath("layout-" + width + ".png"),
      fullPage: true,
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animations = await page
    .getByRole("button", { name: "Flip board" })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(animations).toBe("0s");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.getAnimations().filter((animation) => animation.playState === "running").length,
      ),
    )
    .toBe(0);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expectArenaLayout(page);
  await page.screenshot({ path: testInfo.outputPath("text-200-percent.png"), fullPage: true });
  await setPseudoLocalization(page, true);
  await expectArenaLayout(page);
  await page.screenshot({ path: testInfo.outputPath("expanded-translation.png"), fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
