import type { ChessColor, GameSnapshot } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "../board/PieceIcon";
import { cx } from "../ui/cx";
import { StableText } from "../ui/StableText";

/** One seat of the equal-width pair above the board: color, identity, and activity. */
export function PlayerSummary({
  color,
  snapshot,
}: {
  readonly color: ChessColor;
  readonly snapshot: GameSnapshot | null;
}) {
  const { t } = useTranslation();
  const isTurn = snapshot?.state === "active" && snapshot.turn === color;
  return (
    <div
      className="relative flex min-w-0 items-center gap-3 p-4 not-first:border-l not-first:border-divider max-sm:gap-[min(0.5rem,8px)] max-sm:px-[min(0.5rem,8px)] max-sm:py-[min(0.75rem,12px)]"
      data-seat={color}
      aria-label={t("players.label", { color: t(`players.${color}`) })}
    >
      <PieceIcon color={color} kind="k" className="size-8 max-sm:size-[min(1.5rem,24px)]" />
      <div className="flex min-w-0 flex-col wrap-anywhere">
        <span className="text-label text-text-secondary">{t(`players.${color}`)}</span>
        <strong className="font-semibold max-sm:text-label">{t("players.guest")}</strong>
        <span className={cx("text-caption", isTurn ? "text-accent" : "text-text-muted")}>
          <StableText
            value={t(
              !snapshot
                ? "players.ready"
                : snapshot.state !== "active"
                  ? "players.inspecting"
                  : isTurn
                    ? "players.toMove"
                    : "players.waiting",
            )}
            variants={(["ready", "inspecting", "toMove", "waiting"] as const).map((key) =>
              t(`players.${key}`),
            )}
          />
        </span>
      </div>
      {isTurn ? (
        <span className="absolute inset-x-4 -bottom-px h-0.5 bg-accent" aria-hidden="true" />
      ) : null}
    </div>
  );
}
