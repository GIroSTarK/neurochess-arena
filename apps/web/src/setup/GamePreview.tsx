import type { ChessColor, GameSnapshot } from "@neurochess/contracts";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import type { SandboxApi } from "../api/client";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { gameStatus } from "../game/messages";
import { OperationGate } from "../game/operations";
import { MoveHistory } from "../game/panels/MoveHistory";
import { RecoveryController } from "../game/recovery";
import { GameSession } from "../game/session";
import { interactionEpoch, isTerminal } from "../game/state";
import { SandboxStore } from "../game/store";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

export function GamePreview({
  api,
  initial,
  recovered,
  orientation,
  onSetup,
}: {
  readonly api: SandboxApi;
  readonly initial: GameSnapshot;
  readonly recovered: boolean;
  readonly orientation: ChessColor;
  readonly onSetup: () => void;
}) {
  const { t } = useTranslation();
  const board = useRef<ChessboardHandle>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [game] = useState(() => {
    const store = new SandboxStore();
    const gate = new OperationGate();
    const commandId = () => crypto.randomUUID();
    const session = new GameSession({
      api,
      store,
      gate,
      commandId,
      archive: {
        cancel: () => undefined,
        loadReplay: () => Promise.resolve(),
      },
    });
    store.transition({ phase: "ready", snapshot: initial, pendingCommand: null }, { notice: null });
    const recovery = new RecoveryController({
      api,
      store,
      gate,
      commandId,
      session,
      navigation: undefined,
    });
    return { store, gate, session, recovery };
  });
  const state = useSyncExternalStore(game.store.subscribe, game.store.get);
  useEffect(() => {
    game.gate.connect();
    if (recovered) void game.recovery.recover();
    return () => game.gate.disconnect();
  }, [game, recovered]);
  useLayoutEffect(() => {
    if (!recovered && (!document.activeElement || document.activeElement === document.body)) {
      board.current?.focus();
    }
  }, [recovered]);
  const snapshot = state.snapshot;
  const epoch = interactionEpoch(state);
  const terminal = snapshot && isTerminal(snapshot);
  if (state.phase === "access-error") {
    return (
      <section
        aria-label={t("sandbox.gameDetails")}
        className="space-y-4 rounded-panel border border-warning bg-surface p-6"
      >
        <p role="alert">{t("setup.accessError")}</p>
        <Button variant="primary" onClick={onSetup}>
          {t("setup.returnSetup")}
        </Button>
      </section>
    );
  }
  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,640px)_minmax(0,1fr)]">
      <section aria-label={t("sandbox.playArea")}>
        {snapshot ? (
          <Chessboard
            ref={board}
            snapshot={snapshot}
            orientation={orientation}
            canMove={false}
            interactionEpoch={epoch}
            onMove={() => undefined}
          />
        ) : null}
      </section>
      <section aria-label={t("sandbox.gameDetails")} className="min-w-0 space-y-5">
        <h2 className="font-display text-section">
          {t(recovered ? "setup.returned" : "setup.created")}
        </h2>
        <p role="status">{snapshot ? gameStatus(snapshot, t) : t("setup.accessError")}</p>
        <p className="text-text-secondary">{t("setup.previewHint")}</p>
        {recovered ? <p className="text-label text-warning">{t("setup.recoveredHint")}</p> : null}
        {state.phase !== "ready" ? (
          <div role="status" className="space-y-3">
            <p>{t("setup.checkGame")}</p>
            <Button
              variant="secondary"
              aria-disabled={
                state.phase === "recovering" ||
                state.phase === "submitting" ||
                state.phase === "synchronizing"
              }
              onClick={() => {
                void (state.phase === "uncertain"
                  ? game.session.retryCommand()
                  : state.phase === "sync-required"
                    ? game.session.synchronize()
                    : game.recovery.recover());
              }}
            >
              {t(state.phase === "uncertain" ? "actions.retryCommand" : "actions.retryRecovery")}
            </Button>
          </div>
        ) : null}
        {terminal ? (
          <Button variant="primary" onClick={onSetup}>
            {t("setup.newMatch")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            aria-disabled={state.phase !== "ready"}
            onClick={() => setConfirmation(epoch)}
          >
            {t("setup.stop")}
          </Button>
        )}
        <MoveHistory moves={snapshot?.moves ?? []} />
      </section>
      {confirmation === epoch && state.phase === "ready" && !terminal ? (
        <Dialog
          title={t("lifecycle.abortTitle")}
          description={t("lifecycle.abortDescription")}
          onCancel={() => setConfirmation(null)}
        >
          <div className="my-4 flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setConfirmation(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmation(null);
                void game.session.lifecycle({ action: "abort" });
              }}
            >
              {t("setup.stop")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
