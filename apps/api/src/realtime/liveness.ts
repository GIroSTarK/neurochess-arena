import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

export function watchRoomLiveness(
  socket: WebSocket,
  heartbeatMs: number,
  pongTimeoutMs: number,
  terminate: () => void,
) {
  let probe: string | undefined;
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    timer = setTimeout(() => {
      probe = randomUUID();
      timer = setTimeout(terminate, pongTimeoutMs);
      timer.unref();
      socket.ping(probe, false, (error: Error | undefined) => {
        if (error) terminate();
      });
    }, heartbeatMs);
    timer.unref();
  }
  function pong(data: Buffer) {
    if (probe === undefined || data.toString() !== probe) return;
    probe = undefined;
    clearTimeout(timer);
    schedule();
  }
  socket.on("pong", pong);
  schedule();
  return () => {
    clearTimeout(timer);
    socket.off("pong", pong);
  };
}
