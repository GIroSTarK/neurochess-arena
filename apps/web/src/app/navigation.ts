import { type AuthForm, type GameMode, parseGameId } from "./route-urls";

export type GameTarget =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "game"; readonly gameId: string };

export function readBrowserGameTarget(): GameTarget {
  const ids = new URL(window.location.href).searchParams.getAll("game");
  if (ids.length === 0) return { kind: "none" };
  const id = parseGameId(ids[0]);
  return ids.length === 1 && id ? { kind: "game", gameId: id } : { kind: "invalid" };
}

export function openBrowserGame(mode: GameMode, gameId: string, replace = false): void {
  const id = parseGameId(gameId);
  if (!id) throw new Error("Invalid game identity");
  const url = `${mode === "arena" ? "/" : "/sandbox"}?game=${id}`;
  if (window.location.pathname + window.location.search === url) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", url);
}

export function openBrowserSetup(): void {
  window.history.replaceState(null, "", "/");
}

export type AppPage = "arena" | "account" | "history" | "sandbox" | "reference" | "not-found";
export type AccountPage = "arena" | "history" | "profile" | "credentials" | "auth";

export const readPathname = () => window.location.pathname;

export function appPage(pathname: string): AppPage {
  if (pathname === "/dev/arena" || pathname === "/dev/arena/") return "reference";
  if (pathname === "/sandbox" || pathname === "/sandbox/") return "sandbox";
  if (pathname === "/") return "arena";
  if (pathname === "/history") return "history";
  if (
    [
      "/account",
      "/account/credentials",
      "/auth/sign-in",
      "/auth/sign-up",
      "/auth/verify",
      "/auth/forgot-password",
      "/auth/reset-password",
    ].includes(pathname)
  ) {
    return "account";
  }
  return "not-found";
}

export function accountPage(pathname: string): AccountPage {
  if (pathname.startsWith("/auth/")) return "auth";
  if (pathname === "/account/credentials") return "credentials";
  if (pathname === "/account") return "profile";
  return pathname === "/history" ? "history" : "arena";
}

export function authForm(pathname: string): AuthForm {
  switch (pathname) {
    case "/auth/sign-up":
      return "sign-up";
    case "/auth/verify":
      return "verify";
    case "/auth/forgot-password":
      return "forgot-password";
    case "/auth/reset-password":
      return "reset-password";
    default:
      return "sign-in";
  }
}

export function subscribeToNavigation(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
