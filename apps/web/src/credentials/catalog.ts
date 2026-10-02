import type { CredentialMetadata } from "@neurochess/contracts";

import { type CredentialApi, credentialError } from "../api/credential-client";

export interface CredentialCatalogState {
  readonly credentials: readonly CredentialMetadata[];
  readonly phase: "loading" | "ready" | "error";
}

export class CredentialCatalog {
  private state: CredentialCatalogState = { credentials: [], phase: "loading" };
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private connected = false;
  private channel: BroadcastChannel | null = null;
  constructor(readonly api: CredentialApi | null) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: CredentialCatalogState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private readonly clear = () => {
    this.request?.abort();
    this.request = null;
    this.publish({ credentials: [], phase: "loading" });
  };
  connect() {
    if (!this.api) return () => undefined;
    this.connected = true;
    const refresh = () => {
      void this.refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("pagehide", this.clear);
    this.api.signal.addEventListener("abort", this.clear);
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("neurochess.credentials");
      this.channel.onmessage = refresh;
    }
    const timer = setInterval(refresh, 15_000);
    refresh();
    return () => {
      this.connected = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("pagehide", this.clear);
      this.api?.signal.removeEventListener("abort", this.clear);
      this.channel?.close();
      this.channel = null;
      this.clear();
    };
  }
  readonly refresh = async () => {
    if (!this.api || !this.connected || this.api.signal.aborted) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    // A superseded read cannot make pre-mutation metadata settle an uncertain save.
    this.publish({ ...this.state, phase: "loading" });
    const current = () => this.connected && !request.signal.aborted && !this.api?.signal.aborted;
    try {
      const result = await this.api.list(request.signal);
      if (current()) this.publish({ credentials: result.credentials, phase: "ready" });
    } catch (error) {
      if (current() && credentialError(error) !== "cancelled") {
        this.publish({ ...this.state, phase: "error" });
      }
    }
  };
  async changed() {
    this.channel?.postMessage("changed");
    await this.refresh();
  }
}
