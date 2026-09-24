import {
  type AuthErrorCode,
  type AuthOAuthProvider,
  authOAuthStartResponseSchema,
} from "@neurochess/contracts";
import { z } from "zod";

import { OAUTH_COMPLETION_PATH } from "./oauth.js";

export function oauthCompletion(
  webOrigin: string,
  result: "signed-in" | "linked" | AuthErrorCode,
): string {
  const url = new URL(OAUTH_COMPLETION_PATH, webOrigin);
  url.hash = new URLSearchParams(
    result === "signed-in" || result === "linked" ? { status: result } : { error: result },
  ).toString();
  return url.href;
}

export function oauthCallbackLocation(response: Response, webOrigin: string): string {
  const location = response.headers.get("location");
  for (const result of ["signed-in", "linked"] as const) {
    if (response.status === 302 && location === oauthCompletion(webOrigin, result)) return location;
  }
  let code: AuthErrorCode = "AUTH_OAUTH_FAILED";
  if (location) {
    const url = new URL(location, webOrigin);
    if (url.origin === webOrigin && url.pathname === OAUTH_COMPLETION_PATH) {
      const error = url.searchParams.get("error");
      if (
        [
          "account_not_linked",
          "email_does_not_match",
          "account_already_linked_to_different_user",
          "AUTH_OAUTH_CONFLICT",
        ].includes(error ?? "")
      ) {
        code = "AUTH_OAUTH_CONFLICT";
      }
      if (error === "AUTH_REAUTHENTICATION_REQUIRED") code = "AUTH_REAUTHENTICATION_REQUIRED";
    }
  }
  return oauthCompletion(webOrigin, code);
}

export function oauthStartResponse(body: unknown, provider: AuthOAuthProvider) {
  const result = z.object({ url: z.url(), redirect: z.literal(false) }).parse(body);
  const url = new URL(result.url);
  const expected =
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://github.com/login/oauth/authorize";
  if (`${url.origin}${url.pathname}` !== expected || url.username || url.password || url.hash) {
    throw new Error("OAUTH_INVALID_DESTINATION");
  }
  return authOAuthStartResponseSchema.parse({ url: url.href, redirect: true });
}
