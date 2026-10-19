import AxeBuilder from "@axe-core/playwright";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";

for (const [path, title] of [
  ["/privacy.html", "Privacy Policy"],
  ["/terms.html", "Terms of Service"],
] as const) {
  test(`${title} is public without JavaScript, cookies, or the API`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      ignoreHTTPSErrors: true,
      viewport: testInfo.project.use.viewport!,
    });
    try {
      const page = await context.newPage();
      const apiRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith(API_ORIGIN)) apiRequests.push(request.url());
      });
      await context.route(API_ORIGIN + "/**", (route) => route.abort());
      const response = await page.goto(WEB_ORIGIN + path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(title + " · Neurochess Arena");
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2 })).toHaveCount(9);
      await expect(
        page.getByRole("link", { name: "support@neurochess-arena.com" }),
      ).toHaveAttribute("href", "mailto:support@neurochess-arena.com");
      expect(apiRequests).toEqual([]);
      expect(await context.cookies()).toEqual([]);
      await page.getByRole("navigation", { name: "On this page" }).getByRole("link").last().click();
      await expect(page).toHaveURL(WEB_ORIGIN + path + "#changes");
      await page.getByRole("link", { name: "Return to Neurochess Arena" }).click();
      await expect(page.getByRole("heading", { name: "Neurochess Arena" })).toBeVisible();
      await expect(page.getByRole("link", { name: title, exact: true })).toHaveAttribute(
        "href",
        path,
      );
    } finally {
      await context.close();
    }
  });

  test(`${title} supports keyboard navigation, enlarged text, and accessible layout`, async ({
    page,
  }, testInfo) => {
    await page.goto(path);
    const loadedFonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return Array.from(document.fonts)
        .filter((font) => font.status === "loaded")
        .map((font) => font.family);
    });
    expect(loadedFonts.some((family) => family.includes("Inter Variable"))).toBe(true);
    expect(loadedFonts.some((family) => family.includes("Orbitron Variable"))).toBe(true);
    await expect(page.getByRole("main")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
        .violations,
    ).toEqual([]);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize(testInfo.project.use.viewport!);
    await page.getByRole("heading", { level: 1 }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(path.slice(1) + ".png"), fullPage: true });
  });
}

test("homepage and sign-in expose policy links without replacing the current document", async ({
  page,
  context,
}) => {
  for (const path of ["/", "/auth/sign-in", "/auth/sign-up"]) {
    await page.goto(path);
    const legal = page.getByRole("navigation", { name: "Legal information" });
    for (const [title, destination] of [
      ["Privacy Policy", "/privacy.html"],
      ["Terms of Service", "/terms.html"],
    ] as const) {
      const link = legal.getByRole("link", { name: title, exact: true });
      await expect(link).toHaveAttribute("href", destination);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noreferrer");
    }
    const opened = context.waitForEvent("page");
    await legal.getByRole("link", { name: "Privacy Policy", exact: true }).click();
    const policy = await opened;
    await policy.waitForLoadState("load");
    await policy.evaluate(() => document.fonts.ready);
    await expect(policy.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible();
    await expect(page).toHaveURL(WEB_ORIGIN + path);
    await policy.close();
  }
});
