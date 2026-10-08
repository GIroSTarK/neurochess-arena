import type { GameReplayResponse } from "@neurochess/contracts";

import type { FailureNotice } from "./failures";

/** Retrying a replay request can retain an already verified position and cursor. */
export type ReplayState = (
  | { readonly replay: null; readonly replayPly: 0 }
  | { readonly replay: GameReplayResponse; readonly replayPly: number }
) &
  (
    | { readonly replayPhase: "idle" | "loading"; readonly replayNotice: null }
    | { readonly replayPhase: "error"; readonly replayNotice: FailureNotice }
  );

export type ExportState =
  | {
      readonly exportPhase: "idle" | "loading" | "copied" | "downloaded";
      readonly exportText: null;
      readonly exportNotice: null;
    }
  | {
      readonly exportPhase: "manual";
      readonly exportText: string;
      readonly exportNotice: null;
    }
  | {
      readonly exportPhase: "error";
      readonly exportText: null;
      readonly exportNotice: FailureNotice;
    };

export const emptyReplay: ReplayState = {
  replay: null,
  replayPly: 0,
  replayPhase: "idle",
  replayNotice: null,
};

export const emptyExport: ExportState = {
  exportPhase: "idle",
  exportText: null,
  exportNotice: null,
};

export type ArchiveState = ReplayState & ExportState;

export type ArchiveAnnouncement =
  | {
      readonly kind: "notice";
      readonly notice: FailureNotice | "pgn-copied" | "pgn-downloaded" | "pgn-manual";
    }
  | { readonly kind: "replay"; readonly ply: number; readonly san: string | null };

export interface ArchiveFeedback {
  readonly announcement?: ArchiveAnnouncement;
  readonly invalidateInteraction?: boolean;
}
