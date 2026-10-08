import type {
  AiControlledTurnCommand,
  ChessColor,
  GameDetails,
  GameInvocations,
  GameReplayResponse,
  LifecycleCommand,
  MoveCommand,
  ProviderFailure,
} from "@neurochess/contracts";

import type { AiRequestFailure } from "../api/ai-client";

export type MatchIssue =
  | { kind: "notice"; code: "recovered" | "uncertain" | "unavailable" | "access" }
  | { kind: "request"; code: AiRequestFailure["code"] }
  | { kind: "provider"; color: ChessColor; error: ProviderFailure };

export interface MatchActivity {
  readonly lease: boolean;
  readonly running: boolean;
  readonly busy: boolean;
  readonly turn:
    | { readonly phase: "idle"; readonly command: null }
    | { readonly phase: "thinking" | "uncertain"; readonly command: AiControlledTurnCommand };
  readonly control: LifecycleCommand | null;
  readonly humanCommand: MoveCommand | null;
}

export const idleActivity = {
  lease: false,
  running: false,
  busy: false,
  turn: { phase: "idle", command: null },
  control: null,
  humanCommand: null,
} as const satisfies MatchActivity;

export type MatchFlow = {
  readonly speed: number;
  readonly issue: MatchIssue | null;
} & (
  | {
      readonly phase: "loading" | "setup" | "unavailable";
      readonly details: null;
      readonly activity: typeof idleActivity;
      readonly startedGameId: null;
    }
  | {
      readonly phase: "ready" | "recovering" | "uncertain";
      readonly details: GameDetails;
      readonly activity: MatchActivity;
      readonly startedGameId: string | null;
    }
);

export type SeatKey =
  | { readonly source: "session"; readonly ready: boolean }
  | { readonly source: "saved"; readonly credentialId: string };

export interface SeatKeysState {
  readonly white: SeatKey;
  readonly black: SeatKey;
  readonly epoch: number;
}

export const emptySeatKeys: SeatKeysState = {
  white: { source: "session", ready: false },
  black: { source: "session", ready: false },
  epoch: 0,
};

export type InvocationState = { readonly phase: "idle" | "loading" | "error" } & (
  | { readonly records: null; readonly moveCount: 0 }
  | { readonly records: GameInvocations; readonly moveCount: number }
);

export const emptyInvocations: InvocationState = { phase: "idle", records: null, moveCount: 0 };

// Preserve the facade's snapshot contract while collaborators work with complete store slices.
export interface MatchState {
  readonly phase: MatchFlow["phase"];
  readonly details: GameDetails | null;
  readonly thinking: boolean;
  readonly busy: boolean;
  readonly canMove: boolean;
  readonly pendingMove: boolean;
  readonly pendingControl: boolean;
  readonly keys: Readonly<Record<ChessColor, boolean>>;
  readonly selections: Readonly<Record<ChessColor, string>>;
  readonly keyEpoch: number;
  readonly speed: number;
  readonly issue: MatchIssue | null;
  readonly startedGameId: string | null;
  readonly replay: GameReplayResponse | null;
  readonly replayPly: number;
  readonly replayLoading: boolean;
  readonly replayError: boolean;
  readonly exportBusy: boolean;
  readonly exportResult: "copied" | "downloaded" | "manual" | "error" | null;
  readonly exportText: string | null;
  readonly invocations: GameInvocations | null;
  readonly invocationsMoveCount: number;
  readonly invocationsLoading: boolean;
  readonly invocationsError: boolean;
}

export function humanColor(details: GameDetails | null): ChessColor | null {
  const configuration = details?.configuration;
  return configuration?.mode === "ai_vs_human"
    ? configuration.seats.white.type === "human"
      ? "white"
      : "black"
    : null;
}

export function matchKeysReady(state: Pick<MatchState, "details" | "keys">): boolean {
  const configuration = state.details?.configuration;
  return (
    configuration !== null &&
    configuration !== undefined &&
    (["white", "black"] as const).every(
      (color) => configuration.seats[color].type === "human" || state.keys[color],
    )
  );
}
