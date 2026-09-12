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
  compact = false,
}: PlayerSummaryData & {
  readonly color: ChessColor;
  readonly compact?: boolean;
}) {
  const { t } = useTranslation();
  const { isTurn } = activity;
  return (
    <div
      className={cx(
        "relative flex min-w-0 items-center gap-3 not-first:border-l not-first:border-divider max-sm:gap-[min(0.5rem,8px)] max-sm:px-[min(0.5rem,8px)] max-sm:py-[min(0.75rem,12px)]",
        compact ? "p-3" : "p-4",
      )}
      data-seat={color}
      aria-label={t("players.label", { color: t(`players.${color}`) })}
    >
      <PieceIcon
        color={color}
        kind="k"
        className={
          compact ? "size-10 max-sm:size-[min(2rem,32px)]" : "size-8 max-sm:size-[min(1.5rem,24px)]"
        }
      />
      <div className="flex min-w-0 flex-col wrap-anywhere">
        <span className={cx("text-text-secondary", compact ? "text-caption" : "text-label")}>
          {t(`players.${color}`)}
        </span>
        <strong className={cx("font-semibold max-sm:text-label", compact && "text-label")}>
          {identity.kind === "human" ? identity.name : identity.model}
        </strong>
        {identity.kind === "ai" ? (
          <span className="text-caption text-text-secondary">{identity.provider}</span>
        ) : null}
        <span
          className={cx(
            "relative w-fit text-caption",
            isTurn ? "text-accent" : "text-text-muted",
            compact &&
              isTurn &&
              "after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:bg-accent",
          )}
        >
          <StableText value={activity.label} variants={activity.variants} />
        </span>
      </div>
      {isTurn && !compact ? (
        <span className="absolute inset-x-4 -bottom-px h-0.5 bg-accent" aria-hidden="true" />
      ) : null}
    </div>
  );
}
