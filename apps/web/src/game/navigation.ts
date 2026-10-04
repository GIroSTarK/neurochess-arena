import {
  type GameTarget,
  openBrowserGame,
  readBrowserGameTarget,
  subscribeToNavigation,
} from "../app/navigation";

export type NavigationTarget = GameTarget;

export interface SandboxNavigation {
  read(): NavigationTarget;
  open(gameId: string, replace?: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function browserNavigation(): SandboxNavigation {
  return {
    read: readBrowserGameTarget,
    open(gameId, replace = false) {
      openBrowserGame("sandbox", gameId, replace);
    },
    subscribe: subscribeToNavigation,
  };
}
