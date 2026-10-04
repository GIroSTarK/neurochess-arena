import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect } from "@playwright/test";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";

export async function createAccount(request: APIRequestContext) {
  const email = `${randomUUID()}@example.com`;
  const password = "browser account fixture 🌙";
  const headers = { origin: WEB_ORIGIN };
  expect(
    (
      await request.post(API_ORIGIN + "/api/auth/sign-up/email", {
        headers,
        data: { email, password },
      })
    ).ok(),
  ).toBe(true);
  let link = "";
  await expect
    .poll(async () => {
      const response = await request.post(API_ORIGIN + "/__test__/mail", {
        data: { email, kind: "verification" },
      });
      const body = (await response.json()) as { link: string | null };
      link = body.link ?? "";
      return Boolean(link);
    })
    .toBe(true);
  expect((await request.get(link)).ok()).toBe(true);
  expect(
    (
      await request.post(API_ORIGIN + "/api/auth/sign-in/email", {
        headers,
        data: { email, password },
      })
    ).ok(),
  ).toBe(true);
  const username = "Player_" + randomUUID().slice(0, 8);
  expect(
    (await request.post(API_ORIGIN + "/profile/onboarding", { headers, data: { username } })).ok(),
  ).toBe(true);
  return { email, password, username };
}
