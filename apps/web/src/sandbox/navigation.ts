import { gameIdSchema } from "@neurochess/contracts";

export interface SandboxNavigation {
  read(): string | null;
  open(gameId: string, replace?: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function browserNavigation(): SandboxNavigation {
  return {
    read() {
      const ids = new URL(window.location.href).searchParams.getAll("game");
      if (ids.length === 0) return null;
      const parsed = gameIdSchema.safeParse(ids[0]);
      // Invalid links fail locally; no unvalidated value enters a request path.
      return ids.length === 1 && parsed.success ? parsed.data.toLowerCase() : "invalid";
    },
    open(gameId, replace = false) {
      const url = "/?game=" + encodeURIComponent(gameId);
      if (window.location.pathname + window.location.search === url) return;
      window.history[replace ? "replaceState" : "pushState"](null, "", url);
    },
    subscribe(listener) {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
  };
}
