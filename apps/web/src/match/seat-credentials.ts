import {
  type ChessColor,
  type CredentialMetadata,
  sessionApiKeySchema,
} from "@neurochess/contracts";

import type { createSessionCredentials } from "../api/session-credentials";

import type { SeatKey, SeatKeysState } from "./state";
import type { MatchStore } from "./store";

export type SessionCredentials = ReturnType<typeof createSessionCredentials>;
const colors = ["white", "black"] as const;

export class SeatCredentials {
  private credentials: SessionCredentials | null = null;
  constructor(private readonly store: MatchStore) {}
  get current() {
    return this.credentials;
  }
  open(credentials: SessionCredentials) {
    this.credentials = credentials;
  }
  close() {
    this.credentials?.dispose();
    this.credentials = null;
  }
  refresh() {
    const seats: Record<ChessColor, SeatKey> = {
      white: { source: "session", ready: false },
      black: { source: "session", ready: false },
    };
    for (const color of colors) {
      const seat = this.store.get().details?.configuration?.seats[color];
      if (seat?.type !== "ai") continue;
      try {
        const source = this.credentials?.require(color, seat.provider);
        if (source) {
          seats[color] =
            "credentialId" in source
              ? { source: "saved", credentialId: source.credentialId }
              : { source: "session", ready: true };
        }
      } catch {
        /* Missing keys are expected after recovery. */
      }
    }
    this.store.setSeats({ ...seats, epoch: this.store.getSeats().epoch } satisfies SeatKeysState);
  }
  setCredential(color: ChessColor, credential: string, saved: readonly CredentialMetadata[]) {
    const state = this.store.get();
    const seat = state.details?.configuration?.seats[color];
    if (
      seat?.type !== "ai" ||
      !this.credentials ||
      state.thinking ||
      state.busy ||
      state.details?.snapshot.state !== "paused"
    ) {
      return;
    }
    if (
      credential !== "session" &&
      !saved.some((item) => item.credentialId === credential && item.provider === seat.provider)
    ) {
      return;
    }
    this.credentials.remove(color);
    if (credential !== "session") this.credentials.setSaved(color, seat.provider, credential);
    this.refresh();
  }
  reconcile(saved: readonly CredentialMetadata[]) {
    const state = this.store.get();
    if (state.details?.snapshot.state !== "paused" || state.thinking || state.busy) return;
    let changed = false;
    for (const color of colors) {
      const selected = state.selections[color];
      const seat = state.details.configuration?.seats[color];
      if (
        selected !== "session" &&
        seat?.type === "ai" &&
        !saved.some((item) => item.credentialId === selected && item.provider === seat.provider)
      ) {
        this.credentials?.remove(color);
        changed = true;
      }
    }
    if (changed) {
      this.refresh();
      this.store.setSeats({ ...this.store.getSeats(), epoch: this.store.getSeats().epoch + 1 });
    }
  }
  setKey(color: ChessColor, value: string) {
    const state = this.store.get();
    const seat = state.details?.configuration?.seats[color];
    if (seat?.type !== "ai" || !this.credentials || state.thinking || state.busy) return;
    this.credentials.remove(color);
    if (sessionApiKeySchema.safeParse(value).success) {
      this.credentials.set(color, seat.provider, value);
    }
    this.refresh();
  }
}
