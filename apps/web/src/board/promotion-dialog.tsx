import type { ChessColor } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import type { PromotionKind, Square } from "../position/position";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";

import { PieceIcon } from "./piece-icon";

interface PromotionDialogProps {
  readonly color: ChessColor;
  readonly destination: Square;
  readonly choices: readonly { kind: PromotionKind; move: string }[];
  readonly onChoose: (move: string) => void;
  readonly onCancel: () => void;
}

export function PromotionDialog({
  color,
  destination,
  choices,
  onChoose,
  onCancel,
}: PromotionDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("promotion.title", { color: t(`players.${color}`), square: destination })}
      description={t("promotion.description")}
      onCancel={onCancel}
    >
      <div className="@container my-6">
        <div className="grid grid-cols-1 gap-3 @min-[14rem]:grid-cols-2 @min-[30rem]:grid-cols-4">
          {choices.map(({ kind, move }) => (
            <button
              type="button"
              className="flex min-h-target min-w-0 flex-col items-center justify-center gap-2 rounded-control border border-control-border bg-surface p-3 text-text hover:shadow-[inset_0_0_0_1px_var(--color-accent)]"
              key={kind}
              aria-label={t("promotion.choice", { piece: t(`promotion.${kind}`) })}
              onClick={() => onChoose(move)}
            >
              <PieceIcon color={color} kind={kind} className="size-12" />
              <span>{t(`promotion.${kind}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <Button variant="secondary" onClick={onCancel}>
        {t("actions.cancel")}
      </Button>
    </Dialog>
  );
}
