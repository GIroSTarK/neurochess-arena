import type { ChessColor } from "@neurochess/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "../../board/piece-icon";
import { cx } from "../../ui/cx";
import { Dialog } from "../../ui/dialog";
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
  const [identityOpen, setIdentityOpen] = useState(false);
  const name = identity.kind === "human" ? identity.name : identity.model;
  const seat = t("players.label", { color: t(`players.${color}`) });
  return (
    <>
      <div
        className="relative flex min-w-0 flex-wrap items-start gap-2 p-2 not-first:border-l not-first:border-divider max-sm:px-[min(0.5rem,8px)] sm:px-3"
        data-seat={color}
        aria-label={seat}
      >
        <PieceIcon color={color} kind="k" className="mt-1 size-6 shrink-0" />
        <div className="flex min-w-0 flex-[1_1_5rem] flex-col wrap-anywhere">
          <span className="text-caption text-text-secondary">{t(`players.${color}`)}</span>
          <button
            type="button"
            className="min-h-target min-w-target rounded-control py-1 text-left text-label font-semibold hover:bg-surface-raised"
            aria-label={t("players.viewIdentity", { color: t(`players.${color}`), name })}
            aria-haspopup="dialog"
            onClick={(event) => {
              // WebKit pointer clicks do not focus buttons; Dialog remembers the active element.
              event.currentTarget.focus({ preventScroll: true });
              setIdentityOpen(true);
            }}
          >
            <span className="line-clamp-2" data-player-name>
              {name}
            </span>
          </button>
          {identity.kind === "ai" ? (
            <span className="text-caption text-text-secondary">{identity.provider}</span>
          ) : null}
          <span
            className={cx(
              "relative w-fit text-caption",
              isTurn ? "text-accent" : "text-text-muted",
              isTurn &&
                "after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:bg-accent",
            )}
          >
            <StableText value={activity.label} variants={activity.variants} />
          </span>
        </div>
      </div>
      {identityOpen ? (
        <Dialog
          title={seat}
          description={identity.kind === "ai" ? identity.provider : t("players.human")}
          closeLabel={t("players.closeIdentity")}
          onCancel={() => setIdentityOpen(false)}
        >
          <p className="mt-3 text-body font-semibold wrap-anywhere">{name}</p>
        </Dialog>
      ) : null}
    </>
  );
}
