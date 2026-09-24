import { z } from "zod";

// This is a fail-closed request context, never an identity or an authorization grant.
export const gameIdentityContextSchema = z.enum(["guest", "account"]).optional();
export const GAME_IDENTITY_HEADER = "x-neurochess-identity";
