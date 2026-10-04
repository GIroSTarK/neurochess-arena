import type { CredentialMetadata } from "@neurochess/contracts";

export interface CredentialCatalogState {
  readonly credentials: readonly CredentialMetadata[];
  readonly phase: "loading" | "ready" | "error";
}

const channels = new Set<BroadcastChannel>();
export function notifyCredentialChange() {
  channels.forEach((channel) => channel.postMessage("changed"));
}

export function observeCredentialChanges(refresh: () => void) {
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("neurochess.credentials");
  if (channel) {
    channels.add(channel);
    channel.onmessage = refresh;
  }
  const timer = setInterval(refresh, 15_000);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("pageshow", refresh);
    if (channel) {
      channels.delete(channel);
      channel.close();
    }
  };
}
