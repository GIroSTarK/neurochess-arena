import type { ChessColor } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "../../board/piece-icon";
import { cx } from "../../ui/cx";
import { StableText } from "../../ui/stable-text";

export interface PlayerSummaryData {
  readonly identity:
    | { readonly kind: "human"; readonly name: string }
    | { readonly kind: "ai"; readonly provider: string; readonly model: string };
  readonly activity: {
    readonly label: string;
    readonly variants: readonly string[];
    readonly isTurn: boolean;
  };
}

export function PlayerSummary({
  color,
  identity,
  activity,
}: PlayerSummaryData & {
  readonly color: ChessColor;
}) {
  const { t } = useTranslation();
  const { isTurn } = activity;
  return (
    <div
      className="relative flex min-w-0 flex-wrap items-center gap-3 p-3 not-first:border-l not-first:border-divider max-sm:gap-[min(0.5rem,8px)] max-sm:px-[min(0.5rem,8px)] max-sm:py-[min(0.75rem,12px)]"
      data-seat={color}
      aria-label={t("players.label", { color: t(`players.${color}`) })}
    >
      <PieceIcon color={color} kind="k" className="size-10 max-sm:size-[min(2rem,32px)]" />
      <div className="flex min-w-0 flex-[1_1_5rem] flex-col wrap-anywhere">
        <span className="text-caption text-text-secondary">{t(`players.${color}`)}</span>
        <strong className="text-label font-semibold">
          {identity.kind === "human" ? identity.name : identity.model}
        </strong>
        {identity.kind === "ai" ? (
          <span className="text-caption text-text-secondary">{identity.provider}</span>
        ) : null}
        <span
          className={cx(
            "relative w-fit text-caption",
            isTurn ? "text-accent" : "text-text-muted",
            isTurn && "after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:bg-accent",
          )}
        >
          <StableText value={activity.label} variants={activity.variants} />
        </span>
      </div>
    </div>
  );
}
