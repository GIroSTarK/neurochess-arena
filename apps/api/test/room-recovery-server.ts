import { createGameRepository } from "@neurochess/database";

import { integrationDatabase } from "../../../test/database.js";
import { buildApp } from "../src/app.js";
import { createGameService } from "../src/games/service.js";
import { createGuestService } from "../src/guests/service.js";
import { createOperations } from "../src/monitoring/operations.js";
import { createProviderModelService } from "../src/providers/model-service.js";
import { createRoomEvents } from "../src/realtime/room-events.js";
import { createRoomService } from "../src/rooms/service.js";

const database = integrationDatabase();
const repository = createGameRepository(database);
const roomEvents = createRoomEvents();
const guests = createGuestService(repository, 86_400);
const aiAdapters = {};
const operations = createOperations();
const app = await buildApp({
  operations,
  logger: false,
  readiness: database,
  webOrigin: "http://localhost:5173",
  rooms: createRoomService(repository, roomEvents),
  roomEvents,
  providerApi: {
    models: createProviderModelService(repository, { aiAdapters, operations }),
    guests,
  },
  gameApi: {
    games: createGameService(repository, {
      operations,
      aiAdapters,
      roomEvents,
      nodeEnv: "test",
      sandboxEnabled: false,
    }),
    guests,
  },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Missing room server address");
process.send?.(`ws://127.0.0.1:${address.port}/rooms/realtime`);
