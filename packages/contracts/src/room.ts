import { z } from "zod";

import { humanSeatSchema } from "./ai-game.js";

// Seat identities and admission are assigned by the server, never by configuration.
export const humanGameConfigurationSchema = z.strictObject({
  mode: z.literal("human_vs_human"),
  seats: z.strictObject({ white: humanSeatSchema, black: humanSeatSchema }),
});

export type HumanGameConfiguration = z.infer<typeof humanGameConfigurationSchema>;
