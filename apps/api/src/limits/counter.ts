export function createCounter(
  max: number,
  windowMs = 60_000,
  capacity = 4096,
  now: () => number = Date.now,
) {
  const entries = new Map<string, { count: number; expires: number }>();
  return {
    consume(key: string): number {
      const time = now();
      // Fixed windows preserve expiry order; reclaim without scanning live entries.
      for (const [oldKey, entry] of entries) {
        if (entry.expires > time) break;
        entries.delete(oldKey);
      }
      const entry = entries.get(key);
      if (entry) {
        if (entry.count >= max) return Math.max(1, Math.ceil((entry.expires - time) / 1000));
        entry.count++;
      } else {
        if (entries.size >= capacity) {
          const oldest = entries.values().next().value;
          return Math.max(1, Math.ceil(((oldest?.expires ?? time + windowMs) - time) / 1000));
        }
        entries.set(key, { count: 1, expires: time + windowMs });
      }
      return 0;
    },
  };
}
