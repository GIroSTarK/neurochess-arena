import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createRoomRequestSchema,
  roomCreationOperationRequestSchema,
  roomCreationOperationSchema,
  roomErrorResponseSchema,
  roomInvitationRequestSchema,
  roomIssuedResponseSchema,
  roomJoinRequestSchema,
  roomResolutionRequestSchema,
  roomResolutionSchema,
  roomViewSchema,
} from "./room.js";

const id = "10000000-0000-4000-8000-000000000001";
const invitation = "a".repeat(42) + "A";
describe("room HTTP contracts", () => {
  it("exports every room boundary as a convertible OpenAPI JSON schema", () => {
    for (const schema of [
      createRoomRequestSchema,
      roomCreationOperationRequestSchema,
      roomCreationOperationSchema,
      roomErrorResponseSchema,
      roomInvitationRequestSchema,
      roomIssuedResponseSchema,
      roomJoinRequestSchema,
      roomResolutionRequestSchema,
      roomResolutionSchema,
      roomViewSchema,
    ]) {
      expect(z.toJSONSchema(schema)).toHaveProperty("$schema");
    }
  });
  it("accepts only a known-operation reference and owner color at creation", () => {
    expect(
      createRoomRequestSchema.safeParse({ operationId: id, ownerColor: "black" }).success,
    ).toBe(true);
    for (const patch of [
      { fen: "start" },
      { ownerId: id },
      { invitation },
      { seats: {} },
      { operationId: "unknown" },
      { ownerColor: "red" },
    ]) {
      expect(
        createRoomRequestSchema.safeParse({ operationId: id, ownerColor: "white", ...patch })
          .success,
      ).toBe(false);
    }
  });
  it("bounds secrets to canonical 32-byte base64url codes and never accepts authority in join bodies", () => {
    expect(roomJoinRequestSchema.safeParse({ invitation, commandId: id }).success).toBe(true);
    for (const value of [
      "",
      "a".repeat(42),
      "a".repeat(44),
      "a".repeat(43),
      invitation + "\n",
      "https://example.com/#invite=" + invitation,
    ]) {
      expect(roomJoinRequestSchema.safeParse({ invitation: value, commandId: id }).success).toBe(
        false,
      );
    }
    expect(roomJoinRequestSchema.safeParse({ invitation, commandId: id, userId: id }).success).toBe(
      false,
    );
    expect(
      roomInvitationRequestSchema.safeParse({
        gameId: id,
        commandId: id,
        expectedVersion: 0,
        action: "replace",
      }).success,
    ).toBe(true);
    expect(
      roomInvitationRequestSchema.safeParse({
        gameId: id,
        commandId: id,
        expectedVersion: 0,
        action: "join",
      }).success,
    ).toBe(false);
  });
  it("permits no private preview in invitation resolution", () => {
    expect(roomResolutionSchema.safeParse({ status: "joinable" }).success).toBe(true);
    expect(roomResolutionSchema.safeParse({ status: "unavailable" }).success).toBe(true);
    expect(roomResolutionSchema.safeParse({ status: "joinable", gameId: id }).success).toBe(false);
  });
});
