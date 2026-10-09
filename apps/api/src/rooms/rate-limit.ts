import { RoomRequestError } from "./errors.js";

export function createInvitationRateLimit() {
  const windows = new Map<string, { expiresAt: number; count: number }>();
  return (ip: string) => {
    const now = Date.now();
    const current = windows.get(ip);
    if (current && current.expiresAt > now) {
      if (current.count >= 30) throw new RoomRequestError("RATE_LIMITED");
      current.count++;
      return;
    }
    for (const [key, window] of windows) if (window.expiresAt <= now) windows.delete(key);
    // Bound unauthenticated state even when callers arrive from many socket addresses.
    if (windows.size >= 1024) throw new RoomRequestError("RATE_LIMITED");
    windows.set(ip, { expiresAt: now + 60_000, count: 1 });
  };
}
