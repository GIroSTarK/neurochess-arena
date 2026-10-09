import type { RoomErrorCode } from "@neurochess/contracts";

export class RoomRequestError extends Error {
  constructor(readonly code: RoomErrorCode) {
    super(code);
    this.name = "RoomRequestError";
  }
}
