import { createGameRepository } from "@neurochess/database";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp } from "../src/app.js";
import { createGameService } from "../src/games/service.js";
import { createGuestService } from "../src/guests/service.js";
import { createRoomEvents } from "../src/realtime/room-events.js";
import { createRoomService } from "../src/rooms/service.js";

const database = integrationDatabase();
const repository = createGameRepository(database);
const roomEvents = createRoomEvents();
const app = await buildApp({
  logger: false,
  readiness: database,
  webOrigin: "http://localhost:5173",
  rooms: createRoomService(repository, roomEvents),
  roomEvents,
  gameApi: {
    games: createGameService(repository, { roomEvents, nodeEnv: "test", sandboxEnabled: false }),
    guests: createGuestService(repository, 86_400),
  },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Missing room server address");
process.send?.(`ws://127.0.0.1:${address.port}/rooms/realtime`);
