import { type RoomServerMessage, roomServerMessageSchema } from "@neurochess/contracts";
import WebSocket from "ws";

import { type TestApi, WEB_ORIGIN } from "./helpers.js";
import { RoomApiHarness } from "./room-api-helpers.js";

export class RoomSocketHarness extends RoomApiHarness {
  private readonly sockets = new Set<WebSocket>();

  async address(api: TestApi) {
    if (!api.app.server.listening) await api.app.listen({ host: "127.0.0.1", port: 0 });
    const bound = api.app.server.address();
    if (!bound || typeof bound === "string") throw new Error("Missing socket address");
    return `ws://127.0.0.1:${bound.port}/rooms/realtime`;
  }

  async connect(api: TestApi | string, cookie: string, options: WebSocket.ClientOptions = {}) {
    const socket = new WebSocket(typeof api === "string" ? api : await this.address(api), {
      ...options,
      headers: { cookie, origin: WEB_ORIGIN },
    });
    this.sockets.add(socket);
    const messages: RoomServerMessage[] = [];
    const listeners = new Set<() => void>();
    const consumed = new Map<string, number>();
    socket.on("message", (data) => {
      if (!Buffer.isBuffer(data)) throw new Error("Unexpected socket frame encoding");
      messages.push(roomServerMessageSchema.parse(JSON.parse(data.toString())));
      for (const notify of listeners) notify();
    });
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return {
      socket,
      messages,
      closed,
      subscribe(gameId: string, expectedIdentity: string) {
        socket.send(JSON.stringify({ protocol: 1, type: "subscribe", gameId, expectedIdentity }));
      },
      async next<T extends RoomServerMessage["type"]>(type: T) {
        const find = () =>
          messages.filter((message) => message.type === type)[consumed.get(type) ?? 0];
        if (!find()) {
          await new Promise<void>((resolve, reject) => {
            const notify = () => {
              if (!find()) return;
              clearTimeout(timer);
              listeners.delete(notify);
              resolve();
            };
            const timer = setTimeout(() => {
              listeners.delete(notify);
              reject(new Error(`Missing room ${type} frame`));
            }, 3000);
            listeners.add(notify);
          });
        }
        const message = find();
        consumed.set(type, (consumed.get(type) ?? 0) + 1);
        return message as Extract<RoomServerMessage, { type: T }>;
      },
    };
  }

  async rejectedUpgrade(api: TestApi, cookie: string) {
    const socket = new WebSocket(await this.address(api), {
      headers: { cookie, origin: WEB_ORIGIN },
    });
    this.sockets.add(socket);
    return new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode!);
      });
      socket.once("open", () => reject(new Error("Unexpected upgrade")));
      socket.on("error", () => undefined);
    });
  }

  override async dispose() {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    await super.dispose();
  }
}
