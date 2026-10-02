export type AppPage = "arena" | "account" | "history" | "sandbox" | "reference" | "not-found";

export function readAppPage(): AppPage {
  const { pathname } = window.location;
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

export function subscribeToNavigation(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
