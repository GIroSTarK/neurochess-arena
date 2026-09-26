import { type AuthPage, authPaths } from "../auth/navigation";

export type AppPage =
  "arena" | "sandbox" | "reference" | "not-found" | "account" | "history" | AuthPage;

export function readAppPage(): AppPage {
  const { pathname } = window.location;
  if (pathname === "/dev/arena" || pathname === "/dev/arena/") return "reference";
  if (pathname === "/sandbox" || pathname === "/sandbox/") return "sandbox";
  if (pathname === "/") return "arena";
  if (pathname === "/account") return "account";
  if (pathname === "/history" || pathname === "/history/") return "history";
  const authPage = authPaths.find((page) => pathname === "/auth/" + page);
  if (authPage) return authPage;
  return "not-found";
}

export function subscribeToNavigation(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
