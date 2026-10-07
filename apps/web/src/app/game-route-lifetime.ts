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
  private committedKey: string | null = null;
  private routeRevision = 0;
  private connectedRevision = 0;
  private handoff: string | null = null;
  private status: "running" | "departing" | "stopped" = "running";
  private target: GameTarget = { kind: "none" };
  private signal: AbortSignal | undefined;
  private pendingEntry = false;
  private entryData: unknown;
  private refreshEntry: (() => void) | undefined;
  private refreshPending = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly mode: GameMode,
    create: (navigation: GameNavigation) => T,
    private enter: (controller: T, target: GameTarget) => void,
    private readonly navigate: (href: string, replace: boolean) => void,
    private readonly navigation: RouteNavigation,
  ) {
    this.controller = create({
      game: (gameId, reason) => {
        if (this.key === gameId && !this.stopped) return;
        const href = gameHref(this.mode, gameId);
        this.handoff = gameId;
        // Neither creation nor recovery is a page change: Start keeps its board focus, and
        // recovery must not move focus or scroll.
        this.navigation.preserveFocus(href);
        this.navigate(href, this.mode === "arena" || reason === "recovered");
      },
      setup: () => {
        if (this.mode === "arena") this.depart();
        else this.handoff = "setup";
        this.navigate(this.mode === "arena" ? "/" : "/sandbox", true);
      },
    });
  }

  private get stopped() {
    return this.status !== "running";
  }

  readonly getSnapshot = () => this.status;
  readonly getRouteRevision = (target: GameTarget) => {
    const key = target.kind === "game" ? target.gameId : target.kind === "none" ? "setup" : null;
    return key === this.committedKey ? this.routeRevision : this.connectedRevision;
  };
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(status: typeof this.status) {
    if (this.status === status) return;
    this.status = status;
    this.listeners.forEach((listener) => listener());
  }

  readonly accepts = (destination: RouteAddress) => {
    const key = gameRouteKey(this.mode, destination);
    return key !== null && key === (this.handoff ?? this.key);
  };

  readonly hasHandoff = (destination: RouteAddress) =>
    this.handoff !== null &&
    this.handoff !== this.committedKey &&
    !this.stopped &&
    this.accepts(destination);

  readonly arrived = (destination: RouteAddress) => {
    if (this.status === "departing" && this.accepts(destination)) this.publish("stopped");
    const key = gameRouteKey(this.mode, destination);
    if (key === this.committedKey) return;
    this.committedKey = key;
    this.routeRevision++;
  };

  updateEntry(
    enter: (controller: T, target: GameTarget) => void,
    data?: unknown,
    refresh?: () => void,
  ) {
    this.enter = enter;
    this.refreshEntry = refresh;
    if (this.refreshPending && data !== this.entryData) {
      this.refreshPending = false;
      this.pendingEntry = true;
    }
    this.entryData = data;
  }

  private stop(status: "departing" | "stopped") {
    this.pendingEntry = false;
    this.refreshPending = false;
    this.handoff = null;
    this.publish(status);
    this.controller.endLifetime();
  }

  readonly depart = () => this.stop("departing");
  readonly end = () => this.stop(this.status === "departing" ? "departing" : "stopped");

  readonly retry = () => {
    if (this.signal?.aborted) return;
    if (this.refreshEntry) {
      if (this.refreshPending) return;
      this.refreshPending = true;
      this.refreshEntry();
      return;
    }
    this.startEntry();
  };

  private startEntry() {
    if (this.signal?.aborted) return;
    this.publish("running");
    this.enter(this.controller, this.target);
  }

  activate() {
    if (!this.pendingEntry) return;
    this.pendingEntry = false;
    this.startEntry();
  }

  connect(target: GameTarget, signal?: AbortSignal) {
    this.target = target;
    this.signal = signal;
    const key = target.kind === "game" ? target.gameId : target.kind === "none" ? "setup" : null;
    if (this.routeRevision === 0) this.committedKey = key;
    this.connectedRevision = this.routeRevision;
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
