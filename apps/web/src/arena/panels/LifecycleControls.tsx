import type { ChessColor } from "@neurochess/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/Icon";
import { StableText } from "../../ui/StableText";
import { resignationConfirmation } from "../resignation";
import { type BoardInspectionProps, useBoardInspection } from "../useBoardInspection";

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
  readonly boardTools: BoardInspectionProps;
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
  const { flipButton, helpButton, descriptions } = useBoardInspection(boardTools, {
    flipVariant: "secondary",
    flipClassName: cx(
      "lg:@lg:row-start-1",
      threeColumns ? "lg:@lg:col-start-2" : "lg:@lg:col-start-1",
    ),
    helpClassName: cx(
      "max-lg:border-control-border max-lg:bg-surface max-lg:text-text lg:@lg:row-start-3 lg:@lg:justify-self-start",
      threeColumns ? "lg:@lg:col-start-3" : "lg:@lg:col-start-2",
    ),
  });
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
        {flipButton}
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
        {helpButton}
        {abort}
        <span
          className="col-span-full col-start-1 row-start-2 hidden h-px bg-divider lg:@lg:block"
          aria-hidden="true"
        />
      </div>
      {descriptions}
      {confirmation ? (
        <ConfirmDialog
          {...(confirmation.action === "abort"
            ? {
                title: t("lifecycle.abortTitle"),
                description: abortDescription,
                confirmLabel: t("lifecycle.confirmAbort"),
              }
            : resignationConfirmation(confirmation.losingColor, t))}
          cancelLabel={t("actions.cancel")}
          actionsClassName="my-4 flex flex-wrap gap-3"
          buttonClassName="flex-[1_1_8rem]"
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
