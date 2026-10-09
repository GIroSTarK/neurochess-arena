export interface RoomEvents {
  publish(gameId?: string): void;
  subscribe(listener: (gameId?: string) => void): () => void;
}

// Notifications carry no private projection. Each connection reads its own
// authorized view; undefined invalidates access after an account/history change.
export function createRoomEvents(): RoomEvents {
  const listeners = new Set<(gameId?: string) => void>();
  return {
    publish(gameId) {
      for (const listener of listeners) {
        try {
          listener(gameId);
        } catch {
          // A delivery failure cannot turn an already committed command into an error.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
