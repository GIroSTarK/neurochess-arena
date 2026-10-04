import type { GameTarget } from "./navigation";
import { gameRouteKey, type RouteAddress, type RouteNavigation } from "./route-navigation";
import { gameHref, type GameMode } from "./route-urls";

interface GameNavigation {
  readonly game: (gameId: string, reason: "created" | "recovered") => void;
  readonly setup: () => void;
}

export class GameRouteLifetime<T extends { endLifetime(): void }> {
  readonly controller: T;
  private key: string | null = null;
  private handoff: string | null = null;
  private stopped = false;
  private target: GameTarget = { kind: "none" };
  private signal: AbortSignal | undefined;
  private pendingEntry = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly mode: GameMode,
    create: (navigation: GameNavigation) => T,
    private readonly enter: (controller: T, target: GameTarget) => void,
    private readonly navigate: (href: string, replace: boolean) => void,
    private readonly navigation: RouteNavigation,
  ) {
    this.controller = create({
      game: (gameId, reason) => {
        if (this.key === gameId && !this.stopped) return;
        const href = gameHref(this.mode, gameId);
        this.handoff = gameId;
        if (reason === "created") this.navigation.preserveFocus(href);
        this.navigate(href, this.mode === "arena" || reason === "recovered");
      },
      setup: () => {
        this.handoff = "setup";
        this.navigate(this.mode === "arena" ? "/" : "/sandbox", true);
      },
    });
  }

  readonly getSnapshot = () => this.stopped;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(stopped: boolean) {
    this.stopped = stopped;
    this.listeners.forEach((listener) => listener());
  }

  readonly accepts = (destination: RouteAddress) => {
    const key = gameRouteKey(this.mode, destination);
    return key !== null && key === (this.handoff ?? this.key);
  };

  readonly end = () => {
    this.pendingEntry = false;
    this.handoff = null;
    this.publish(true);
    this.controller.endLifetime();
  };

  readonly retry = () => {
    if (this.signal?.aborted) return;
    this.publish(false);
    this.enter(this.controller, this.target);
  };

  activate() {
    if (!this.pendingEntry) return;
    this.pendingEntry = false;
    this.retry();
  }

  connect(target: GameTarget, signal?: AbortSignal) {
    this.target = target;
    this.signal = signal;
    const key = target.kind === "game" ? target.gameId : target.kind === "none" ? "setup" : null;
    const handedOff = key !== null && this.handoff === key && !this.stopped;
    this.key = key;
    this.handoff = null;
    this.pendingEntry = !handedOff;
    const unregister = this.navigation.register(this);
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) this.retry();
    };
    window.addEventListener("pagehide", this.end);
    window.addEventListener("pageshow", pageshow);
    signal?.addEventListener("abort", this.end, { once: true });
    return () => {
      this.pendingEntry = false;
      unregister();
      window.removeEventListener("pagehide", this.end);
      window.removeEventListener("pageshow", pageshow);
      signal?.removeEventListener("abort", this.end);
    };
  }
}
