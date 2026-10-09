import { gameIdSchema } from "@neurochess/contracts";

export type GameMode = "arena" | "sandbox";
export type AuthForm = "sign-in" | "sign-up" | "verify" | "forgot-password" | "reset-password";

export function parseGameId(value: unknown): string | null {
  const parsed = gameIdSchema.safeParse(value);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export function gameHref(mode: GameMode, gameId: string): string {
  const id = parseGameId(gameId);
  if (!id) throw new Error("Invalid game identity");
  return `${mode === "sandbox" ? "/sandbox" : ""}/games/${id}`;
}

export function safeReturnTo(value: string | null): string {
  if (value === "/" || value === "/history" || value === "/rooms" || value === "/rooms/join") {
    return value;
  }
  const match = value?.match(/^\/games\/([^/?#]+)$/);
  const id = parseGameId(match?.[1]);
  return id ? gameHref("arena", id) : "/";
}

export function authHref(page: Exclude<AuthForm, "reset-password">, returnTo = "/"): string {
  return withReturnTo(`/auth/${page}`, returnTo);
}

export function withReturnTo(pathname: string, returnTo = "/"): string {
  const destination = safeReturnTo(returnTo);
  return `${pathname}${destination === "/" ? "" : "?returnTo=" + encodeURIComponent(destination)}`;
}
