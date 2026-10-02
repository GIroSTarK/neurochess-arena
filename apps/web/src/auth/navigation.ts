import { authErrorCodeSchema, gameParamsSchema } from "@neurochess/contracts";

export function safeReturnTo(value: string | null): string {
  if (value === "/" || value === "/history") return value;
  if (!value?.startsWith("/?")) return "/";
  const url = new URL(value, window.location.origin);
  const gameId = url.searchParams.get("game");
  const parsed = gameParamsSchema.safeParse({ gameId });
  if (url.hash || url.searchParams.size !== 1 || !parsed.success) {
    return "/";
  }
  return "/?game=" + parsed.data.gameId.toLowerCase();
}

export function consumeAuthEntry() {
  const url = new URL(window.location.href);
  const callback = url.searchParams.get("auth");
  const error = authErrorCodeSchema.safeParse(url.searchParams.get("code"));
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("token");
  let resetToken =
    url.pathname === "/auth/reset-password" && fragment.size === 1 && token && token.length <= 2048
      ? token
      : null;
  const returnTo = safeReturnTo(
    url.searchParams.get("returnTo") ??
      (url.pathname === "/" || url.pathname === "/history" ? url.pathname + url.search : null),
  );
  if (url.pathname.startsWith("/auth/") || url.pathname === "/account" || callback) {
    window.history.replaceState(null, "", url.pathname);
  }
  return {
    readResetToken: () => resetToken,
    clearResetToken: () => {
      resetToken = null;
    },
    returnTo,
    verified: callback === "email-verified",
    error:
      callback === "oauth-error"
        ? error.success && error.data.startsWith("AUTH_OAUTH_")
          ? error.data
          : ("AUTH_OAUTH_FAILED" as const)
        : callback === "verification-error"
          ? error.success
            ? error.data
            : ("AUTH_INVALID_TOKEN" as const)
          : null,
  };
}

export type AuthEntry = ReturnType<typeof consumeAuthEntry>;

export function authHref(
  page: "sign-in" | "sign-up" | "verify" | "forgot-password",
  returnTo = "/",
) {
  const destination = safeReturnTo(returnTo);
  return `/auth/${page}${destination === "/" ? "" : "?returnTo=" + encodeURIComponent(destination)}`;
}
