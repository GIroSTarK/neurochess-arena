import { roomInvitationSchema } from "@neurochess/contracts";

export function parseInvitation(
  input: string,
  origin: string,
  joinPath = "/rooms/join",
): string | null {
  const text = input.trim();
  const code = roomInvitationSchema.safeParse(text);
  if (code.success) return code.data;
  if (text.length > 1024 || !URL.canParse(text)) return null;
  const url = new URL(text);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    url.origin !== origin ||
    url.pathname !== joinPath ||
    url.search ||
    url.username ||
    url.password ||
    fragment.size !== 1
  ) {
    return null;
  }
  const parsed = roomInvitationSchema.safeParse(fragment.get("invite"));
  return parsed.success ? parsed.data : null;
}

export function consumeRoomInvitation(joinPath = "/rooms/join") {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  const retire = () => {
    value = null;
  };
  const consume = (initial = false) => {
    const url = new URL(window.location.href);
    if (!new URLSearchParams(url.hash.slice(1)).has("invite")) return;
    value = parseInvitation(url.href, url.origin, joinPath);
    window.history.replaceState(
      initial ? null : (window.history.state as unknown),
      "",
      url.pathname + url.search,
    );
    listeners.forEach((listener) => listener());
  };
  consume(true);
  // Capture native fragment arrivals before the router can retain the secret in a location.
  const capture = () => consume();
  window.addEventListener("popstate", capture, true);
  window.addEventListener("hashchange", capture, true);
  window.addEventListener("pagehide", retire);
  return {
    read: () => value,
    retire,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      retire();
      listeners.clear();
      window.removeEventListener("popstate", capture, true);
      window.removeEventListener("hashchange", capture, true);
      window.removeEventListener("pagehide", retire);
    },
  };
}

export type RoomInvitationEntry = ReturnType<typeof consumeRoomInvitation>;
