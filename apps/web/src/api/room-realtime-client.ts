import {
  roomClientMessageSchema,
  type RoomServerMessage,
  roomServerMessageSchema,
} from "@neurochess/contracts";

import { ApiFailure } from "./failures";
import { apiOrigin } from "./http";
import type { PublicIdentity } from "./identity";
import { roomViewFor } from "./room-game-client";

export interface RoomRealtime {
  connect(
    gameId: string,
    handlers: { message: (message: RoomServerMessage) => void; disconnected: () => void },
  ): () => void;
}

export function createRoomRealtime(
  baseUrl: string,
  identity: PublicIdentity,
  createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
): RoomRealtime {
  const url = apiOrigin(baseUrl, () => new ApiFailure("malformed"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/rooms/realtime";
  return {
    connect(gameId, handlers) {
      let retired = false;
      let socket: WebSocket | null = null;
      const close = () => {
        if (retired) return;
        retired = true;
        identity.signal.removeEventListener("abort", close);
        if (!socket) return;
        socket.removeEventListener("open", open);
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", disconnected);
        socket.removeEventListener("close", disconnected);
        socket.close();
      };
      const disconnected = () => {
        if (retired) return;
        close();
        handlers.disconnected();
      };
      const open = () => {
        if (retired || identity.signal.aborted) return;
        const subscription = roomClientMessageSchema.safeParse({
          protocol: 1,
          type: "subscribe",
          gameId,
          expectedIdentity: identity.intent === "account" ? identity.expectedAccount : "guest",
        });
        if (!subscription.success) {
          disconnected();
          return;
        }
        try {
          socket?.send(JSON.stringify(subscription.data));
        } catch {
          disconnected();
        }
      };
      const message = (event: MessageEvent<unknown>) => {
        if (retired || identity.signal.aborted) return;
        let frame: RoomServerMessage;
        try {
          if (typeof event.data !== "string" || event.data.length > 2_000_000) throw new Error();
          frame = roomServerMessageSchema.parse(JSON.parse(event.data) as unknown);
          if (frame.type === "snapshot" || frame.type === "update") roomViewFor(frame.room, gameId);
          else if ("gameId" in frame && frame.gameId !== gameId) throw new Error();
        } catch {
          disconnected();
          return;
        }
        handlers.message(frame);
        if (frame.type === "access_lost") {
          close();
          identity.lost?.();
        } else if (frame.type === "error") disconnected();
      };
      identity.signal.addEventListener("abort", close, { once: true });
      void identity
        .verify()
        .then(() => {
          if (retired || identity.signal.aborted) {
            close();
            return;
          }
          socket = createSocket(url.href);
          socket.addEventListener("open", open);
          socket.addEventListener("message", message);
          socket.addEventListener("error", disconnected);
          socket.addEventListener("close", disconnected);
        })
        .catch(disconnected);
      return close;
    },
  };
}
