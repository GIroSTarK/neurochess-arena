import websocket from "@fastify/websocket";
import { emptyQuerySchema } from "@neurochess/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { AUTH_COOKIE_PREFIX } from "../auth/constants.js";
import type { AccountAuth } from "../auth/service.js";
import { GameRequestError } from "../games/errors.js";
import { GUEST_COOKIE_NAME, type GuestService } from "../guests/service.js";
import type { Principal } from "../identity/principal.js";
import { enforcePrincipalLimit, handleRateLimitError, sendRateLimit } from "../limits/http.js";
import { clientIp, ipBudgetKey } from "../limits/proxy.js";
import { RoomRequestError } from "../rooms/errors.js";
import type { RoomService } from "../rooms/service.js";

import {
  createRoomConnections,
  ROOM_MESSAGE_BYTES,
  type RoomConnectionLimits,
} from "./connections.js";
import type { RoomEvents } from "./room-events.js";

export interface RoomRealtimeOptions {
  rooms: RoomService;
  guests: GuestService;
  auth?: AccountAuth;
  webOrigin: string;
  events: RoomEvents;
  limits?: Partial<RoomConnectionLimits>;
}

export async function registerRoomRealtime(app: FastifyInstance, options: RoomRealtimeOptions) {
  const connections = createRoomConnections(options.rooms, options.events, options.limits);
  const principals = new WeakMap<FastifyRequest, Principal>();
  // ws supports closeTimeout; its separately published type declarations lag it.
  const socketOptions = {
    maxPayload: ROOM_MESSAGE_BYTES,
    perMessageDeflate: false,
    autoPong: false,
    maxFragments: 32,
    maxBufferedChunks: 32,
    closeTimeout: 1000,
  };
  await app.register(websocket, {
    options: socketOptions,
    errorHandler(_error, socket) {
      // Invalid frames have no safe diagnostic payload.
      if (socket.readyState !== socket.CLOSING) {
        socket.terminate();
      }
    },
    preClose(done) {
      connections.close();
      this.websocketServer.close(done);
    },
  });

  app.get(
    "/rooms/realtime",
    {
      websocket: true,
      onRequest: async (request, reply) => {
        reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
        if (request.headers.origin !== options.webOrigin) return reply.code(403).send();
        if (
          !emptyQuerySchema.safeParse(request.query).success ||
          request.headers["sec-websocket-protocol"] !== undefined
        ) {
          return reply.code(400).send();
        }
        if (!request.ws) return reply.code(404).send();
        if (!connections.reserve(request.raw.socket, ipBudgetKey(clientIp(request)))) {
          return sendRateLimit(request, reply, 1);
        }
      },
      preValidation: async (request, reply) => {
        try {
          const account = await options.auth?.resolve(
            new Headers(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
          );
          const hasAccountCookie = Object.keys(request.cookies).some(
            (name) =>
              name === `${AUTH_COOKIE_PREFIX}.session_token` ||
              name === `__Secure-${AUTH_COOKIE_PREFIX}.session_token`,
          );
          if (!account && hasAccountCookie) throw new GameRequestError("UNAUTHORIZED");
          const principal =
            account ??
            (await options.guests.authenticate(request.cookies[GUEST_COOKIE_NAME])).principal;
          enforcePrincipalLimit(request, principal);
          await options.rooms.authorize(principal);
          if (!connections.bind(request.raw.socket, principal)) {
            connections.release(request.raw.socket);
            return await sendRateLimit(request, reply, 1);
          }
          principals.set(request, principal);
        } catch (error) {
          connections.release(request.raw.socket);
          if (handleRateLimitError(error, request, reply)) return;
          const status =
            error instanceof GameRequestError
              ? error.code === "UNAUTHORIZED"
                ? 401
                : 403
              : error instanceof RoomRequestError
                ? 403
                : 503;
          return reply.code(status).send();
        }
      },
    },
    (socket, request) => {
      const principal = principals.get(request);
      principals.delete(request);
      if (!principal) {
        socket.terminate();
        return;
      }
      connections.accept(request.raw.socket, socket, principal);
    },
  );
}
