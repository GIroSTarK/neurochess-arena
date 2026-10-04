import { authErrorCodeSchema } from "@neurochess/contracts";

import { safeReturnTo } from "./urls";

export { authHref, safeReturnTo } from "./urls";

export function readAuthEntry(url: URL, consumeReset = false) {
  const callback = url.searchParams.get("auth");
  const error = authErrorCodeSchema.safeParse(url.searchParams.get("code"));
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("token");
  let resetToken =
    consumeReset &&
    /^\/auth\/reset-password\/?$/.test(url.pathname) &&
    fragment.size === 1 &&
    token &&
    token.length <= 2048
      ? token
      : null;
  const returnTo = safeReturnTo(url.searchParams.get("returnTo") ?? url.pathname + url.search);
  let active = true;
  return {
    get active() {
      return active;
    },
    readResetToken: () => resetToken,
    clearResetToken: () => {
      resetToken = null;
    },
    returnTo,
    retire: () => {
      active = false;
      resetToken = null;
    },
    get verified() {
      return active && callback === "email-verified";
    },
    get error() {
      return !active
        ? null
        : callback === "oauth-error"
          ? error.success && error.data.startsWith("AUTH_OAUTH_")
            ? error.data
            : ("AUTH_OAUTH_FAILED" as const)
          : callback === "verification-error"
            ? error.success
              ? error.data
              : ("AUTH_INVALID_TOKEN" as const)
            : null;
    },
  };
}

export function consumeAuthEntry() {
  const url = new URL(window.location.href);
  const entry = readAuthEntry(url, true);
  if (
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/account") ||
    url.searchParams.has("auth")
  ) {
    const rejectedGame = url.searchParams.getAll("game");
    const search = new URLSearchParams();
    for (const value of rejectedGame) search.append("game", value);
    window.history.replaceState(
      null,
      "",
      url.pathname + (search.size ? "?" + search.toString() : ""),
    );
  } else if (new URLSearchParams(url.hash.slice(1)).has("token")) {
    window.history.replaceState(null, "", url.pathname + url.search);
  }
  window.addEventListener("pagehide", entry.retire, { once: true });
  return entry;
}

export type AuthEntry = ReturnType<typeof consumeAuthEntry>;
