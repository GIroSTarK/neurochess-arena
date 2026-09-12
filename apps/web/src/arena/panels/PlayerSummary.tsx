import type { ChessColor } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "../../board/PieceIcon";
import { cx } from "../../ui/cx";
import { StableText } from "../../ui/StableText";

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
      className="relative flex min-w-0 items-center gap-3 p-4 not-first:border-l not-first:border-divider max-sm:gap-[min(0.5rem,8px)] max-sm:px-[min(0.5rem,8px)] max-sm:py-[min(0.75rem,12px)]"
      data-seat={color}
      aria-label={t("players.label", { color: t(`players.${color}`) })}
    >
      <PieceIcon color={color} kind="k" className="size-8 max-sm:size-[min(1.5rem,24px)]" />
      <div className="flex min-w-0 flex-col wrap-anywhere">
        <span className="text-label text-text-secondary">{t(`players.${color}`)}</span>
        <strong className="font-semibold max-sm:text-label">
          {identity.kind === "human" ? identity.name : identity.model}
        </strong>
        {identity.kind === "ai" ? (
          <span className="text-caption text-text-secondary">{identity.provider}</span>
        ) : null}
        <span className={cx("text-caption", isTurn ? "text-accent" : "text-text-muted")}>
          <StableText value={activity.label} variants={activity.variants} />
        </span>
      </div>
      {isTurn ? (
        <span className="absolute inset-x-4 -bottom-px h-0.5 bg-accent" aria-hidden="true" />
      ) : null}
    </div>
  );
}
