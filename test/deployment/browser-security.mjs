import assert from "node:assert/strict";

import { expect } from "@playwright/test";

export async function observePolicy(page) {
  await page.addInitScript(() => {
    globalThis.policyViolations = [];
    globalThis.policyDiagnostics = [];
    globalThis.document.addEventListener("securitypolicyviolation", (event) => {
      globalThis.policyViolations.push(event.effectiveDirective);
      globalThis.policyDiagnostics.push({
        directive: event.effectiveDirective,
        blocked: ["eval", "inline", "wasm-eval"].includes(event.blockedURI)
          ? event.blockedURI
          : "URL",
        file: event.sourceFile.match(/\/([\w-]+\.js)(?:[?#]|$)/)?.[1] ?? "document",
        line: event.lineNumber,
      });
    });
  });
}

export async function checkBrowserPolicy(page, web, api) {
  assert.deepEqual(
    await page.evaluate(() => globalThis.policyViolations),
    [],
    JSON.stringify(await page.evaluate(() => globalThis.policyDiagnostics)),
  );
  assert.equal(await page.evaluate(() => globalThis.crossOriginIsolated), false);
  await page.evaluate(() => globalThis.document.fonts.ready);
  assert(
    await page.evaluate(() =>
      performance.getEntriesByType("resource").some((entry) => entry.name.endsWith(".woff2")),
    ),
  );

  for (const origin of [
    "https://googleusercontent.com",
    "https://lh3.googleusercontent.com",
    "https://avatars.githubusercontent.com",
  ]) {
    const url = origin + "/avatar-policy-probe.svg";
    let headers;
    await page.route(url, async (route) => {
      headers = await route.request().allHeaders();
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      });
    });
    assert.equal(await loadImage(page, url), true, "Permitted provider avatar blocked");
    assert.equal(headers.referer, undefined, "Avatar request leaked a referrer");
  }
  assert.deepEqual(await page.evaluate(() => globalThis.policyViolations), []);

  // Serve successful responses if CSP lets these requests escape, so failures
  // establish policy enforcement rather than an unreachable test hostname.
  await page.route("https://untrusted.invalid/**", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
    }),
  );
  assert.equal(await loadImage(page, "https://untrusted.invalid/avatar.svg"), false);
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch("https://untrusted.invalid/collect");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.evaluate(() => {
    const script = globalThis.document.createElement("script");
    script.textContent = "globalThis.inlinePolicyProbe = true";
    globalThis.document.head.append(script);
    script.remove();
  });
  assert.equal(await page.evaluate(() => globalThis.inlinePolicyProbe), undefined);
  await expect
    .poll(() => page.evaluate(() => globalThis.policyViolations))
    .toEqual(expect.arrayContaining(["img-src", "connect-src", "script-src-elem"]));

  for (const path of ["/sandbox", "/arena-reference", "/__test__/mail"]) {
    await page.goto(web + path);
    await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
  }

  for (const [provider, label, endpoint] of [
    ["google", "Google", "https://accounts.google.com/o/oauth2/v2/auth"],
    ["github", "GitHub", "https://github.com/login/oauth/authorize"],
  ]) {
    await page.route(endpoint + "?**", async (route) => {
      assert.equal(
        (await route.request().allHeaders()).referer,
        undefined,
        "OAuth navigation leaked a referrer",
      );
      const authorization = new URL(route.request().url());
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        api + `/api/auth/callback/${provider}`,
      );
      const callback = new URL(api + `/api/auth/callback/${provider}`);
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "private-callback-description-canary");
      await route.fulfill({
        contentType: "text/html",
        body: `<a href="${callback.href.replaceAll("&", "&amp;")}">Cancel consent</a>`,
      });
    });
    await page.goto(web + "/auth/sign-in");
    await page.getByRole("button", { name: `Continue with ${label}` }).click();
    await page.getByRole("link", { name: "Cancel consent" }).waitFor();
    const redirect = page.waitForResponse((response) =>
      response.url().startsWith(api + `/api/auth/callback/${provider}`),
    );
    const landing = page.waitForRequest(
      (request) => request.isNavigationRequest() && request.url().startsWith(web + "/"),
    );
    await page.getByRole("link", { name: "Cancel consent" }).click();
    const response = await redirect;
    assert.equal(response.status(), 303);
    assert.equal((await response.allHeaders())["cache-control"], "no-store");
    assert.equal((await response.allHeaders())["referrer-policy"], "no-referrer");
    assert.equal(
      (await (await landing).allHeaders()).referer,
      undefined,
      "Callback redirect leaked a referrer",
    );
    await expect(
      page.getByText("Provider sign-in was cancelled. Choose a method to try again."),
    ).toBeVisible();
    assert(!page.url().includes("state="));
    assert(!page.url().includes("private-callback"));
    assert.deepEqual(await page.evaluate(() => globalThis.policyViolations), []);
  }
}

async function loadImage(page, url) {
  return page.evaluate(
    (source) =>
      new Promise((resolve) => {
        const image = new globalThis.Image();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = source;
      }),
    url,
  );
}
