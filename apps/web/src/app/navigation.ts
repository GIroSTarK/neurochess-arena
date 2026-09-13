export type AppPage = "arena" | "sandbox" | "not-found";

export function readAppPage(): AppPage {
  const { pathname } = window.location;
  if (pathname === "/sandbox" || pathname === "/sandbox/") return "sandbox";
  if (pathname === "/") return "arena";
  return "not-found";
}

export function subscribeToNavigation(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
