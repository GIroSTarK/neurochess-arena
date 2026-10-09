import type { Duplex } from "node:stream";

import {
  roomClientMessageSchema,
  type RoomServerMessage,
  roomServerMessageSchema,
} from "@neurochess/contracts";
import type WebSocket from "ws";

import { GameRequestError } from "../games/errors.js";
import type { Principal } from "../identity/principal.js";
import { RoomRequestError } from "../rooms/errors.js";
import type { RoomService } from "../rooms/service.js";

import type { RoomEvents } from "./room-events.js";

export const ROOM_MESSAGE_BYTES = 4096;
export const roomConnectionLimits = {
  handshakeMs: 5000,
  subscriptionMs: 5000,
  deliveryMs: 5000,
  maxConnections: 1024,
  maxConnectionsPerIdentity: 8,
  maxBufferedBytes: 1024 * 1024,
};
export type RoomConnectionLimits = typeof roomConnectionLimits;

interface Connection {
  readonly transport: Duplex;
  timer: ReturnType<typeof setTimeout> | undefined;
  identity?: string;
  refresh?: (gameId?: string) => void;
  stop?: () => void;
}

export function createRoomConnections(
  rooms: RoomService,
  events: RoomEvents,
  overrides: Partial<RoomConnectionLimits> = {},
) {
  const limits = { ...roomConnectionLimits, ...overrides };
  const connections = new Map<Duplex, Connection>();
  let closed = false;
  const unsubscribe = events.subscribe((gameId) => {
    for (const connection of connections.values()) connection.refresh?.(gameId);
  });

  function release(transport: Duplex) {
    const connection = connections.get(transport);
    if (!connection) return;
    connections.delete(transport);
    clearTimeout(connection.timer);
    connection.stop?.();
  }

  return {
    reserve(transport: Duplex) {
      if (closed || connections.size >= limits.maxConnections) return false;
      const timer = setTimeout(() => {
        release(transport);
        transport.destroy();
      }, limits.handshakeMs);
      timer.unref();
      connections.set(transport, { transport, timer });
      transport.once("close", () => release(transport));
      return true;
    },
    release,
    bind(transport: Duplex, principal: Principal) {
      const connection = connections.get(transport);
      if (!connection || transport.destroyed) return false;
      const identity =
        principal.kind === "account"
          ? `account:${principal.userId}`
          : `guest:${principal.guestSessionId}`;
      if (
        [...connections.values()].filter((entry) => entry.identity === identity).length >=
        limits.maxConnectionsPerIdentity
      ) {
        return false;
      }
      connection.identity = identity;
      return true;
    },
    accept(transport: Duplex, socket: WebSocket, principal: Principal) {
      const connection = connections.get(transport);
      if (!connection || closed) {
        socket.terminate();
        return;
      }
      clearTimeout(connection.timer);
      let stopped = false;
      let gameId: string | undefined;
      let running = false;
      let pending = false;
      let lastVersion = -1;
      let lastProjection: string | undefined;
      let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
      const isStopped = () => stopped;

      function stop() {
        stopped = true;
        pending = false;
        clearTimeout(connection?.timer);
        clearTimeout(deliveryTimer);
      }
      connection.stop = stop;

      function close(code: number, message?: RoomServerMessage) {
        if (stopped) return;
        if (message && socket.readyState === socket.OPEN) send(message);
        stop();
        socket.close(code);
      }

      function send(message: RoomServerMessage) {
        if (stopped || socket.readyState !== socket.OPEN) return false;
        const data = JSON.stringify(roomServerMessageSchema.parse(message));
        if (socket.bufferedAmount + Buffer.byteLength(data) > limits.maxBufferedBytes) {
          close(1013);
          return false;
        }
        socket.send(data, (error) => {
          if (error) {
            stop();
            socket.terminate();
          }
        });
        return true;
      }

      async function drain() {
        if (running || stopped || !gameId) return;
        running = true;
        try {
          while (pending && !isStopped()) {
            pending = false;
            deliveryTimer = setTimeout(() => close(1013), limits.deliveryMs);
            deliveryTimer.unref();
            const room = await rooms.read(principal, gameId);
            // Snapshot reads are repeatable-read. The final authorization uses
            // one current statement so a stale read cannot authorize delivery.
            await rooms.authorize(principal, gameId);
            if (isStopped()) return;
            const projection = JSON.stringify(room);
            if (room.snapshot.version >= lastVersion && projection !== lastProjection) {
              if (!send({ protocol: 1, type: lastVersion < 0 ? "snapshot" : "update", room })) {
                return;
              }
              lastVersion = room.snapshot.version;
              lastProjection = projection;
              clearTimeout(connection?.timer);
            }
            clearTimeout(deliveryTimer);
          }
        } catch (error) {
          if (error instanceof GameRequestError || error instanceof RoomRequestError) {
            close(1008, { protocol: 1, type: "access_lost" });
          } else {
            close(1011, { protocol: 1, type: "error", code: "UNAVAILABLE" });
          }
        } finally {
          clearTimeout(deliveryTimer);
          running = false;
        }
      }

      connection.refresh = (changedGameId) => {
        if (!gameId || (changedGameId !== undefined && changedGameId !== gameId) || stopped) return;
        // Coalesce notifications, not snapshots: at most one pending read per
        // recipient. Installation precedes the baseline read, so no commit is lost.
        pending = true;
        void drain();
      };
      connection.timer = setTimeout(
        () => close(1008, { protocol: 1, type: "error", code: "INVALID_MESSAGE" }),
        limits.subscriptionMs,
      );
      connection.timer.unref();
      socket.on("message", (data, binary) => {
        if (stopped) return;
        try {
          if (binary || !Buffer.isBuffer(data) || gameId) throw new Error("Invalid subscription");
          const parsed = roomClientMessageSchema.safeParse(JSON.parse(data.toString()));
          if (!parsed.success) throw new Error("Invalid subscription");
          const expected = principal.kind === "account" ? principal.userId : "guest";
          if (parsed.data.expectedIdentity !== expected) {
            close(1008, { protocol: 1, type: "access_lost" });
            return;
          }
          gameId = parsed.data.gameId.toLowerCase();
          connection.refresh?.(gameId);
        } catch {
          close(1008, { protocol: 1, type: "error", code: "INVALID_MESSAGE" });
        }
      });
      socket.once("close", () => release(transport));
      socket.on("error", () => {
        stop();
        socket.terminate();
      });
    },
    close() {
      closed = true;
      unsubscribe();
      for (const transport of connections.keys()) {
        release(transport);
        transport.destroy();
      }
    },
  };
}
