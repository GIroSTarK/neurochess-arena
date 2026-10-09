import type { ChessColor } from "@neurochess/contracts";

export function createRoomPresence(changed: (gameId: string) => void) {
  const rooms = new Map<string, Record<ChessColor, number>>();
  return {
    join(gameId: string, color: ChessColor) {
      const counts = rooms.get(gameId) ?? { white: 0, black: 0 };
      rooms.set(gameId, counts);
      if (++counts[color] === 1) changed(gameId);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        const offline = --counts[color] === 0;
        if (counts.white + counts.black === 0) rooms.delete(gameId);
        if (offline) changed(gameId);
      };
    },
    read(gameId: string) {
      const counts = rooms.get(gameId);
      return { white: (counts?.white ?? 0) > 0, black: (counts?.black ?? 0) > 0 };
    },
  };
}

export type RoomPresence = ReturnType<typeof createRoomPresence>;
