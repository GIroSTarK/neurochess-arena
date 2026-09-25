import { authVerifyEmailRequestSchema, gameParamsSchema } from "@neurochess/contracts";

export const authPaths = [
  "sign-in",
  "sign-up",
  "verify-email",
  "resend",
  "forgot-password",
  "reset-password",
  "complete",
] as const;
export type AuthPage = (typeof authPaths)[number];
export interface AuthEntry {
  token?: string;
  result?: "signed-in" | "linked";
  error?: "AUTH_OAUTH_FAILED" | "AUTH_OAUTH_CONFLICT" | "AUTH_REAUTHENTICATION_REQUIRED";
}

export function safeReturn(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  const match = /^\/\?game=([a-fA-F0-9-]+)$/.exec(value);
  return match?.[1] && gameParamsSchema.safeParse({ gameId: match[1] }).success
    ? "/?game=" + match[1].toLowerCase()
    : "/";
}

export function authHref(
  page: AuthPage,
  destination = window.location.pathname + window.location.search,
) {
  const returnTo = safeReturn(destination);
  return "/auth/" + page + (returnTo === "/" ? "" : "?returnTo=" + encodeURIComponent(returnTo));
}

// Strip callbacks before rendering, requests, or remote avatar loading can retain the URL.
export function consumeAuthEntry(): AuthEntry {
  if (!window.location.pathname.startsWith("/auth/")) return {};
  const { pathname, search, hash } = window.location;
  const fragment = new URLSearchParams(hash.slice(1));
  const returnTo = safeReturn(new URLSearchParams(search).get("returnTo"));
  window.history.replaceState(
    null,
    "",
    pathname + (returnTo === "/" ? "" : "?returnTo=" + encodeURIComponent(returnTo)),
  );
  if (pathname === "/auth/verify-email" || pathname === "/auth/reset-password") {
    const parsed = authVerifyEmailRequestSchema.safeParse({ token: fragment.get("token") });
    return parsed.success ? parsed.data : {};
  }
  if (pathname === "/auth/complete") {
    const result = fragment.get("status");
    if (result === "signed-in" || result === "linked") return { result };
    const error = fragment.get("error");
    return {
      error:
        error === "AUTH_OAUTH_CONFLICT" || error === "AUTH_REAUTHENTICATION_REQUIRED"
          ? error
          : "AUTH_OAUTH_FAILED",
    };
  }
  return {};
}

export function navigateAccount(destination: string) {
  window.history.replaceState(null, "", destination);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
