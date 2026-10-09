import { z } from "zod";

import { profileUsernameSchema } from "./profile.js";

export const humanPlayerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), username: profileUsernameSchema }),
  z.strictObject({ kind: z.literal("guest") }),
  z.strictObject({ kind: z.literal("deleted") }),
  z.strictObject({ kind: z.literal("unassigned") }),
]);
