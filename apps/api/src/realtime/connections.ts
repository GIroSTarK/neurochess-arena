import type { Duplex } from "node:stream";

import {
  roomClientMessageSchema,
  type RoomServerMessage,
  roomServerMessageSchema,
} from "@neurochess/contracts";
import type WebSocket from "ws";

import type { Principal } from "../identity/principal.js";
import type { RoomService } from "../rooms/service.js";

import { watchRoomLiveness } from "./liveness.js";
import { createRoomPresence } from "./presence.js";
import type { RoomEvents } from "./room-events.js";
import { createRoomSynchronization } from "./synchronization.js";

export const ROOM_MESSAGE_BYTES = 4096;
export const roomConnectionLimits = {
  handshakeMs: 5000,
  subscriptionMs: 5000,
  deliveryMs: 5000,
  heartbeatMs: 15_000,
  pongTimeoutMs: 10_000,
  reconciliationMs: 15_000,
  maxConnections: 1024,
  maxConnectionsPerIdentity: 8,
  maxConnectionsPerIp: 96,
  controlWindowMs: 10_000,
  maxControlFramesPerWindow: 60,
  maxBufferedBytes: 1024 * 1024,
};
export type RoomConnectionLimits = typeof roomConnectionLimits;

interface Connection {
  readonly transport: Duplex;
  readonly ip: string;
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
  function refresh(gameId?: string) {
    if (closed) return;
    for (const connection of connections.values()) connection.refresh?.(gameId);
  }
  const unsubscribe = events.subscribe(refresh);
  const presence = createRoomPresence(refresh);

  function release(transport: Duplex) {
    const connection = connections.get(transport);
    if (!connection) return;
    connections.delete(transport);
    clearTimeout(connection.timer);
    connection.stop?.();
  }

  return {
    reserve(transport: Duplex, ip: string) {
      if (closed || connections.size >= limits.maxConnections) return false;
      if (
        [...connections.values()].filter((connection) => connection.ip === ip).length >=
        limits.maxConnectionsPerIp
      ) {
        return false;
      }
      const timer = setTimeout(() => {
        release(transport);
        transport.destroy();
      }, limits.handshakeMs);
      timer.unref();
      connections.set(transport, { transport, timer, ip });
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
      let controlFrames = 0;
      let controlWindow = Date.now();
      function controlFrame() {
        if (stopped) return false;
        const now = Date.now();
        if (now - controlWindow >= limits.controlWindowMs) {
          controlWindow = now;
          controlFrames = 0;
        }
        if (++controlFrames <= limits.maxControlFramesPerWindow) return true;
        close(1008);
        return false;
      }
      socket.on("ping", (data) => {
        if (controlFrame()) {
          socket.pong(data, false, (error: Error | undefined) => {
            if (error) socket.terminate();
          });
        }
      });
      socket.on("pong", controlFrame);
      let gameId: string | undefined;
      let synchronization: ReturnType<typeof createRoomSynchronization> | undefined;
      const reconciliation = setInterval(
        () => synchronization?.refresh(true),
        limits.reconciliationMs,
      );
      reconciliation.unref();
      const stopLiveness = watchRoomLiveness(
        socket,
        limits.heartbeatMs,
        limits.pongTimeoutMs,
        () => {
          stop();
          socket.terminate();
        },
      );

      function stop() {
        stopped = true;
        clearTimeout(connection?.timer);
        clearInterval(reconciliation);
        stopLiveness();
        synchronization?.stop();
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

      connection.refresh = (changedGameId) => {
        if (!gameId || (changedGameId !== undefined && changedGameId !== gameId) || stopped) return;
        synchronization?.refresh();
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
          synchronization = createRoomSynchronization({
            rooms,
            principal,
            gameId,
            presence,
            send,
            close,
            deliveryMs: limits.deliveryMs,
            synchronized: () => clearTimeout(connection.timer),
          });
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
