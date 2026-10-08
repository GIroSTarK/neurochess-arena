import type { ChessColor } from "@neurochess/contracts";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";

import { PgnActions } from "../../arena/panels/pgn-actions";
import { ReplayControls } from "../../arena/panels/replay-controls";
import { Chessboard, type ChessboardHandle } from "../../board/chessboard";
import type { MatchController } from "../controller";
import type { MatchPresentation } from "../presentation";
import type { MatchState } from "../state";

import { AiControls } from "./ai-controls";

export function MatchBoard({
  board,
  view,
  state,
  controller,
  orientation,
  helpId,
  boardRef,
}: {
  readonly board: NonNullable<MatchPresentation["board"]>;
  readonly view: MatchPresentation;
  readonly state: MatchState;
  readonly controller: MatchController;
  readonly orientation: ChessColor;
  readonly helpId: string;
  readonly boardRef: Ref<ChessboardHandle>;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Chessboard
        {...board}
        ref={boardRef}
        orientation={orientation}
        describedBy={helpId}
        onMove={(move) => {
          void controller.move(move);
        }}
      />
      {view.terminal ? (
        <>
          <ReplayControls
            available={state.replay !== null}
            loading={state.replayLoading}
            count={board.snapshot.moves.length}
            ply={state.replayPly}
            notice={state.replayError ? t("match.replayError") : null}
            onSelect={(ply) => controller.selectPly(ply)}
            onRetry={
              state.replayError
                ? () => {
                    void controller.loadReplay();
                  }
                : null
            }
          />
          <PgnActions
            busy={state.exportBusy}
            text={state.exportText}
            feedback={
              state.exportResult && state.exportResult !== "error"
                ? t(`export.${state.exportResult}`)
                : null
            }
            error={state.exportResult === "error" ? t("match.exportError") : null}
            onExport={(kind) => {
              void controller.exportPgn(kind);
            }}
          />
        </>
      ) : (
        <AiControls
          {...view.controls}
          onPause={() => {
            void controller.lifecycle("pause");
          }}
          onResume={() => {
            void controller.continue(false);
          }}
          onStep={() => {
            void controller.continue(true);
          }}
          onStop={() => {
            void controller.lifecycle("abort");
          }}
          onSpeed={(speed) => controller.setSpeed(speed)}
          resignation={
            view.controls.resignation
              ? {
                  ...view.controls.resignation,
                  onResign: () => {
                    void controller.lifecycle("resign");
                  },
                }
              : undefined
          }
        />
      )}
    </>
  );
}
