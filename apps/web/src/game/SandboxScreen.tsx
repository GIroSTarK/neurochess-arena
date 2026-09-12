import type { ChessColor } from "@neurochess/contracts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppShell } from "../app/AppShell";
import { ArenaHeader } from "../arena/ArenaHeader";
import { ArenaLayout } from "../arena/ArenaLayout";
import { BoardTools } from "../arena/BoardTools";
import { EntryPanel } from "../arena/EntryPanel";
import { MoveHistory } from "../arena/panels/MoveHistory";
import { ServiceStatus } from "../arena/ServiceStatus";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { Icon } from "../ui/Icon";

import { GameStatus } from "./panels/GameStatus";
import { PgnActions } from "./panels/PgnActions";
import { ReplayControls } from "./panels/ReplayControls";
import { StartButton } from "./panels/StartButton";
import { sandboxPresentation } from "./presentation";
import { useSandbox } from "./useSandbox";

export function SandboxScreen({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const { t } = useTranslation();
  const helpId = useId();
  const { state, controller } = useSandbox(apiBaseUrl);
  const [orientation, setOrientation] = useState<ChessColor>("white");
  const board = useRef<ChessboardHandle>(null);
  const view = sandboxPresentation(state, t);
  const { startedGameId } = view;

  useLayoutEffect(() => {
    if (startedGameId === null) return;
    // Start removes its trigger. Recovery never requests focus, and a later response must not
    // steal it from someone who has already moved to another control.
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) board.current?.focus();
  }, [startedGameId]);

  return (
    <AppShell
      mainId="sandbox"
      skipLabel={t("app.skipLink")}
      context={t("app.localDevelopment")}
      footer={t("sandbox.footer")}
      announcement={view.announcement}
    >
      <ArenaHeader
        title={t("sandbox.title")}
        description={t("sandbox.description")}
        trailing={<ServiceStatus state={state.readiness} />}
      />
      <ArenaLayout
        players={view.players}
        playAreaLabel={t("sandbox.playArea")}
        detailsLabel={t("sandbox.gameDetails")}
        board={
          view.board ? (
            <>
              <Chessboard
                ref={board}
                {...view.board}
                orientation={orientation}
                onMove={(move) => {
                  void controller.submit(move);
                }}
                describedBy={helpId}
              />
              {view.terminal ? <ReplayControls state={state} controller={controller} /> : null}
              <BoardTools
                orientation={orientation}
                onFlip={() =>
                  setOrientation((previous) => (previous === "white" ? "black" : "white"))
                }
                helpId={helpId}
              />
            </>
          ) : (
            <EntryPanel
              title={t("sandbox.entryTitle")}
              description={t("sandbox.entryDescription")}
              action={<StartButton state={state} controller={controller} />}
            />
          )
        }
        details={
          <>
            <GameStatus state={state} controller={controller} />
            <MoveHistory
              moves={view.moves}
              selectedPly={view.selectedPly}
              onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
            />
            {view.terminal ? <PgnActions state={state} controller={controller} /> : null}
            <div className="text-label text-text-muted">
              <span className="flex items-center gap-2 text-text-secondary">
                <Icon path="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
                {t("sandbox.privacy")}
              </span>
              <p className="mt-2">{t("sandbox.memoryHint")}</p>
            </div>
          </>
        }
      />
    </AppShell>
  );
}
