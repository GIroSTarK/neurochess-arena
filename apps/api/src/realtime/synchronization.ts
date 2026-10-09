import type { RoomServerMessage } from "@neurochess/contracts";

import { GameRequestError } from "../games/errors.js";
import type { Principal } from "../identity/principal.js";
import { RoomRequestError } from "../rooms/errors.js";
import type { RoomService } from "../rooms/service.js";

import type { RoomPresence } from "./presence.js";

interface SynchronizationOptions {
  rooms: RoomService;
  principal: Principal;
  gameId: string;
  presence: RoomPresence;
  deliveryMs: number;
  send: (message: RoomServerMessage) => boolean;
  close: (code: number, message?: RoomServerMessage) => void;
  synchronized: () => void;
}

export function createRoomSynchronization(options: SynchronizationOptions) {
  const { rooms, principal, gameId, presence, send, close } = options;
  let stopped = false;
  let running = false;
  let pending = false;
  let reconciliationPending = false;
  let lastVersion = -1;
  let lastProjection: string | undefined;
  let lastPresence: string | undefined;
  let presenceSequence = 0;
  let leave: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isStopped = () => stopped;

  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (pending && !isStopped()) {
        pending = false;
        const reconcile = reconciliationPending;
        reconciliationPending = false;
        timer = setTimeout(() => close(1013), options.deliveryMs);
        timer.unref();
        const room = await rooms.read(principal, gameId);
        // A repeatable-read snapshot cannot authorize current delivery. Check
        // identity and membership together in a fresh statement before any frame.
        await rooms.authorize(principal, gameId);
        if (isStopped()) return;
        if (room.snapshot.version >= lastVersion) {
          const projection = JSON.stringify(room);
          if (projection !== lastProjection) {
            if (
              !send({
                protocol: 1,
                type: lastVersion < 0 || reconcile ? "snapshot" : "update",
                room,
              })
            ) {
              return;
            }
            lastVersion = room.snapshot.version;
            lastProjection = projection;
            options.synchronized();
          }
          leave ??= presence.join(gameId, room.viewer.color);
          const online = presence.read(gameId);
          const presenceProjection = JSON.stringify(online);
          if (presenceProjection !== lastPresence) {
            if (
              !send({ protocol: 1, type: "presence", gameId, sequence: ++presenceSequence, online })
            ) {
              return;
            }
            lastPresence = presenceProjection;
          }
          if (reconcile && !send({ protocol: 1, type: "revision", gameId, version: lastVersion })) {
            return;
          }
        }
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof GameRequestError || error instanceof RoomRequestError) {
        close(1008, { protocol: 1, type: "access_lost" });
      } else {
        close(1011, { protocol: 1, type: "error", code: "UNAVAILABLE" });
      }
    } finally {
      clearTimeout(timer);
      running = false;
    }
  }

  return {
    refresh(reconcile = false) {
      if (stopped) return;
      // Coalesce invalidations, never queue private payloads or concurrent reads.
      pending = true;
      reconciliationPending ||= reconcile;
      void drain();
    },
    stop() {
      stopped = true;
      pending = false;
      clearTimeout(timer);
      leave?.();
    },
  };
}
