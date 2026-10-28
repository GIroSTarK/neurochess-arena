import type { Locator, Page, TestInfo } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { configureCredential, saveCredential } from "./credential-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, submitGame, test } from "./fixtures";
import { confirm, createRoom } from "./room-helpers";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

async function inspectLayouts(
  page: Page,
  info: TestInfo,
  flow: string,
  action: Locator,
  selectedTab?: "Analysis" | "Events",
) {
  const widths = info.project.use.isMobile ? [320, 390] : [768, 1024, 1440];
  for (const width of widths) {
    for (const enlarged of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await setPseudoLocalization(page, enlarged);
      await page.evaluate(async (large) => {
        document.documentElement.style.fontSize = large ? "200%" : "100%";
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
      }, enlarged);
      if (selectedTab) {
        await page.getByRole("tab", { name: new RegExp(`^${selectedTab}`) }).click();
      }
      const overflow = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        return {
          page: Math.max(0, document.documentElement.scrollWidth - viewport),
          content: [...document.querySelectorAll<HTMLElement>("main *, header *")]
            .filter((element) => {
              if (!element.checkVisibility() || element.closest(".sr-only, svg")) return false;
              const rect = element.getBoundingClientRect();
              return (
                rect.right > viewport + 1 ||
                rect.left < -1 ||
                (element.clientWidth > 0 &&
                  /^(DT|DD|TH|TD|BUTTON|P|LABEL)$/.test(element.tagName) &&
                  element.scrollWidth > element.clientWidth + 1 &&
                  getComputedStyle(element).overflowX === "visible")
              );
            })
            .map((element) => ({ tag: element.tagName, classes: element.className })),
        };
      });
      expect(overflow, `${flow}, ${width}px, ${enlarged ? 200 : 100}%`).toEqual({
        page: 0,
        content: [],
      });
      await expectUnbrokenWords(
        page.getByRole("tab").or(
          page
            .getByRole("term")
            .filter({ hasText: /^All-attempt estimate/ })
            .locator(".."),
        ),
      );
      await expect(action).toBeVisible();
      await action.scrollIntoViewIfNeeded();
      await action.focus();
      await expect(action).toBeFocused();
      await expect(action).toBeInViewport();
    }
  }
  await page.screenshot({ path: info.outputPath(`${flow}-expanded.png`), fullPage: true });
  await setPseudoLocalization(page, false);
  await page.evaluate(() => (document.documentElement.style.fontSize = "100%"));
}

test("entry, live analysis, recovery and replay keep expanded telemetry and actions reachable", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await createAccount(page.request);
  await page.goto("/");
  for (const color of ["White", "Black"] as const) {
    await configureCredential(page, color, { apiKey: "slow-fixture" });
    const model = page.getByRole("group", { name: color, exact: true }).getByRole("combobox", {
      name: "Model",
      exact: true,
    });
    await model.fill("fixture/long-");
    await model.press("ArrowDown");
    await model.press("Enter");
  }
  await inspectLayouts(page, info, "entry", page.getByRole("button", { name: /^Start game/ }));
  const { details } = await submitGame(page);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  const commentaryTab = page.getByRole("tab", { name: "Commentary", exact: true });
  if (await commentaryTab.count()) await commentaryTab.click();
  await expect(page.getByRole("term").filter({ hasText: "All-attempt estimate" })).toHaveCount(2);
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  await inspectLayouts(
    page,
    info,
    "live-analysis",
    page.getByRole("button", { name: /^Refresh details/ }),
    "Analysis",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume game", exact: true })).toBeVisible();
  await inspectLayouts(page, info, "recovery", page.getByRole("button", { name: /^Resume game/ }));
  await page.getByLabel("White · OpenAI · API key", { exact: true }).fill("telemetry-fixture");
  await page.getByLabel("Black · OpenAI · API key", { exact: true }).fill("telemetry-fixture");
  await page.getByLabel("Delay between moves").selectOption("500");
  await page.getByRole("button", { name: "Resume game", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Black wins by checkmate", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  await page.getByText("Evaluation values", { exact: true }).first().click();
  await inspectLayouts(
    page,
    info,
    "replay-analysis",
    page.getByRole("button", { name: /^Refresh details/ }),
    "Analysis",
  );
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  await inspectLayouts(
    page,
    info,
    "replay-events",
    page.getByRole("button", { name: /^New game/ }),
    "Events",
  );
  await page.goto("/history");
  await expect(page.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
    "href",
    `/games/${details.snapshot.gameId}`,
  );
  await inspectLayouts(page, info, "history", page.getByRole("button", { name: /^Clear history/ }));
});

test("account and credential forms retain long labels and focused actions in a short viewport", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await createAccount(page.request);
  expect(
    (
      await page.request.post(`${API_ORIGIN}/profile`, {
        headers: { origin: WEB_ORIGIN },
        data: { username: "Long_" + crypto.randomUUID().replaceAll("-", "").slice(0, 19) },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/account");
  await inspectLayouts(page, info, "account", page.getByRole("button", { name: /^Save profile/ }));
  await page.goto("/account/credentials");
  await saveCredential(page, "Label".repeat(12) + "Long", "responsive-fixture-1234", "openrouter");
  await inspectLayouts(page, info, "credentials", page.getByRole("button", { name: /^Save key/ }));
  await page.setViewportSize({ width: 390, height: 360 });
  await page.getByLabel("API key", { exact: true }).click();
  await page.getByLabel("API key", { exact: true }).fill("keyboard-fixture");
  await expect(page.getByLabel("API key", { exact: true })).toBeInViewport();
  const save = page.getByRole("button", { name: "Save key", exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
});

test("room invitation and replay analysis reflow without hiding the close action", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await createRoom(page, "White");
  await inspectLayouts(
    page,
    info,
    "room-waiting",
    page.getByRole("button", { name: /^Close room/ }),
  );
  await confirm(page, "Close room", "Confirm close");
  await page.getByRole("tab", { name: "Analysis", exact: true }).click();
  await page.getByText("Evaluation values", { exact: true }).first().click();
  await inspectLayouts(
    page,
    info,
    "room-replay",
    page.getByRole("link", { name: /^New private room/ }),
  );
});
