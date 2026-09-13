import type { ChessColor } from "@neurochess/contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { Dialog } from "../../ui/Dialog";
import { Icon } from "../../ui/Icon";
import { StableText } from "../../ui/StableText";

type Confirmation = { action: "abort" } | { action: "resign"; losingColor: ChessColor };

interface PendingConfirmation {
  readonly epoch: string;
  readonly action: Confirmation;
}

export interface LifecycleControlsProps {
  readonly paused: boolean;
  readonly disabled: boolean;
  readonly epoch: string;
  readonly onTogglePause?: (() => void) | undefined;
  readonly onAbort?: (() => void) | undefined;
  readonly abortDescription: string;
  readonly resignations: readonly {
    readonly color: ChessColor;
    readonly onResign: () => void;
  }[];
  readonly boardTools: {
    readonly orientation: ChessColor;
    readonly onFlip: () => void;
    readonly helpId: string;
  };
}

export function LifecycleControls({
  paused,
  disabled,
  epoch,
  onTogglePause,
  onAbort,
  abortDescription,
  resignations,
  boardTools,
}: LifecycleControlsProps) {
  const { t } = useTranslation();
  const threeColumns = Boolean(onTogglePause);
  // Equal label reservations keep the gaps between compact resignation buttons identical.
  const resignationLabels = resignations.map(({ color }) =>
    t(color === "white" ? "lifecycle.resignWhite" : "lifecycle.resignBlack"),
  );
  const orientationId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const [pendingConfirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const pending = pendingConfirmation?.action;
  const confirmedAction =
    pending?.action === "abort"
      ? onAbort
      : resignations.find((seat) => seat.color === pending?.losingColor)?.onResign;
  // A revision or capability change invalidates confirmation without replacing its trigger.
  const confirmation =
    !disabled && pendingConfirmation?.epoch === epoch && confirmedAction
      ? pendingConfirmation.action
      : null;
  if (pendingConfirmation !== null && confirmation === null) setConfirmation(null);

  function confirm(action: Confirmation) {
    if (!disabled) setConfirmation({ epoch, action });
  }

  const abort = onAbort ? (
    <Button
      padding="compact"
      variant="quiet-danger"
      aria-disabled={disabled}
      className={cx(
        "max-lg:border-control-border max-lg:bg-surface lg:@lg:row-start-1",
        threeColumns ? "lg:@lg:col-start-3" : "lg:@lg:col-start-2",
      )}
      onClick={() => confirm({ action: "abort" })}
    >
      <Icon path="M6 6h12v12H6z" />
      <span className="min-w-0">{t("lifecycle.abort")}</span>
    </Button>
  ) : null;

  return (
    <div className="@container mt-6" aria-label={t("lifecycle.controls")} role="group">
      <div
        className={cx(
          "grid grid-cols-1 gap-2 @min-[18rem]:grid-cols-2 lg:@lg:gap-y-3",
          threeColumns && "lg:@lg:grid-cols-3",
        )}
      >
        {onTogglePause ? (
          <Button
            padding="compact"
            variant="primary"
            aria-disabled={disabled}
            className="lg:@lg:col-start-1 lg:@lg:row-start-1"
            onClick={() => {
              if (!disabled) onTogglePause();
            }}
          >
            <Icon path={paused ? "M8 5v14l11-7z" : "M9 5v14M15 5v14"} />
            <StableText
              value={t(paused ? "lifecycle.resume" : "lifecycle.pause")}
              variants={[t("lifecycle.pause"), t("lifecycle.resume")]}
              align="center"
            />
          </Button>
        ) : null}
        <Button
          padding="compact"
          variant="secondary"
          className={cx(
            "lg:@lg:row-start-1",
            threeColumns ? "lg:@lg:col-start-2" : "lg:@lg:col-start-1",
          )}
          aria-describedby={orientationId}
          onClick={boardTools.onFlip}
        >
          <Icon path="M3 11a9 9 0 0 1 15-6l3 3M21 3v5h-5M21 13a9 9 0 0 1-15 6l-3-3M3 21v-5h5" />
          <span className="min-w-0">{t("actions.flip")}</span>
        </Button>
        {resignations.map(({ color }, index) => (
          <Button
            key={color}
            padding="compact"
            variant="quiet"
            className={cx(
              "max-lg:border-control-border max-lg:bg-surface max-lg:text-text lg:@lg:row-start-3 lg:@lg:justify-self-start",
              index === 0 ? "lg:@lg:col-start-1" : "lg:@lg:col-start-2",
            )}
            aria-disabled={disabled}
            onClick={() => confirm({ action: "resign", losingColor: color })}
          >
            <Icon path="M5 21V4m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0" />
            <StableText
              value={t(color === "white" ? "lifecycle.resignWhite" : "lifecycle.resignBlack")}
              variants={resignationLabels}
              align="center"
            />
          </Button>
        ))}
        <Button
          padding="compact"
          variant="quiet"
          className={cx(
            "max-lg:border-control-border max-lg:bg-surface max-lg:text-text lg:@lg:row-start-3 lg:@lg:justify-self-start",
            threeColumns ? "lg:@lg:col-start-3" : "lg:@lg:col-start-2",
          )}
          aria-expanded={helpOpen}
          aria-controls={boardTools.helpId}
          onClick={() => setHelpOpen((previous) => !previous)}
        >
          <Icon path="M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" />
          <span className="min-w-0">{t("board.keyboardHelp")}</span>
        </Button>
        {abort}
        <span
          className="col-span-full col-start-1 row-start-2 hidden h-px bg-divider lg:@lg:block"
          aria-hidden="true"
        />
      </div>
      <span id={orientationId} className="sr-only">
        {t(boardTools.orientation === "white" ? "board.whiteBottom" : "board.blackBottom")}
      </span>
      <p id={boardTools.helpId} hidden={!helpOpen} className="mt-4 text-body text-text-secondary">
        {t("board.instructions")}
      </p>
      {confirmation ? (
        <ConfirmationDialog
          action={confirmation}
          abortDescription={abortDescription}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            if (!disabled) confirmedAction?.();
          }}
        />
      ) : null}
    </div>
  );
}

/** Destructive confirmation: Cancel comes first so it receives the initial focus. */
function ConfirmationDialog({
  action,
  abortDescription,
  onCancel,
  onConfirm,
}: {
  readonly action: Confirmation;
  readonly abortDescription: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={
        action.action === "abort"
          ? t("lifecycle.abortTitle")
          : t("lifecycle.resignTitle", { color: t(`players.${action.losingColor}`) })
      }
      description={
        action.action === "abort"
          ? abortDescription
          : t("lifecycle.resignDescription", {
              winner: t(action.losingColor === "white" ? "players.black" : "players.white"),
            })
      }
      onCancel={onCancel}
    >
      <div className="my-4 flex flex-wrap gap-3">
        <Button variant="secondary" className="flex-[1_1_8rem]" onClick={onCancel}>
          {t("actions.cancel")}
        </Button>
        <Button variant="danger" className="flex-[1_1_8rem]" onClick={onConfirm}>
          {t(action.action === "abort" ? "lifecycle.confirmAbort" : "lifecycle.confirmResign")}
        </Button>
      </div>
    </Dialog>
  );
}
