import { authErrorCodeSchema } from "@neurochess/contracts";

import { safeReturnTo } from "./urls";

export { authHref, safeReturnTo } from "./urls";

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
