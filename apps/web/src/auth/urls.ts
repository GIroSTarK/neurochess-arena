import { type AuthForm, parseGameId } from "../app/route-urls";

// Native navigation retains its existing URL contract until the Data router is installed.
export function safeReturnTo(value: string | null): string {
  if (value === "/" || value === "/history") return value;
  if (!value?.startsWith("/?")) return "/";
  const url = new URL(value, "https://arena.invalid");
  const gameId = parseGameId(url.searchParams.get("game"));
  return !url.hash && url.searchParams.size === 1 && gameId ? "/?game=" + gameId : "/";
}

export function authHref(page: Exclude<AuthForm, "reset-password">, returnTo = "/"): string {
  const destination = safeReturnTo(returnTo);
  return `/auth/${page}${destination === "/" ? "" : "?returnTo=" + encodeURIComponent(destination)}`;
}
