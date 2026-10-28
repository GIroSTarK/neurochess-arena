import type { ChessColor, GameDetails, GameInvocations } from "@neurochess/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { plyColor } from "../gameplay/snapshot";
import { Button } from "../ui/button";
import { cx } from "../ui/cx";
import { Dialog } from "../ui/dialog";

import { MoveCost } from "./move-cost";
import { acceptedAttempt, metricValue, moveCost } from "./telemetry";

const commentaryMetrics = ["durationMs", "inputTokens", "outputTokens"] as const;
const previewMessages = [
  "initial",
  "humanMove",
  "noMove",
  "loading",
  "detailsUnavailable",
  "missingCommentary",
] as const;

export function CommentaryPanel({
  details,
  records,
  selectedPly,
  loading = false,
  error = false,
}: {
  readonly details: GameDetails;
  readonly records: GameInvocations | null;
  readonly selectedPly: number | null;
  readonly loading?: boolean;
  readonly error?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  // Keep the opened explanation tied to its move while live play continues underneath.
  const [reading, setReading] = useState<{
    gameId: string;
    move: string;
    identity: string;
    commentary: string;
  } | null>(null);
  const moves = details.snapshot.moves;
  const selected = selectedPly === null ? null : moves.find((move) => move.ply === selectedPly);
  const colors: readonly (ChessColor | null)[] =
    selectedPly === null
      ? (["white", "black"] as const).filter(
          (color) => details.configuration?.seats[color].type === "ai",
        )
      : [selected ? plyColor(selected.ply) : null];
  const pending = !error && (loading || !records || records.version < details.snapshot.version);
  return (
    <section aria-label={t("telemetry.commentary")} className="grid min-w-0 shrink-0 gap-2">
      <h2 className="font-display text-section">{t("telemetry.commentary")}</h2>
      <div className="grid auto-rows-fr gap-2">
        {colors.map((color) => {
          const move = selected ?? moves.findLast((move) => plyColor(move.ply) === color);
          const attempt = move ? acceptedAttempt(records, move.ply) : undefined;
          const seat = color ? details.configuration?.seats[color] : undefined;
          const ai = seat?.type === "ai";
          const moveLabel = color
            ? move
              ? t("telemetry.move", {
                  color: t(`players.${color}`),
                  number: Math.ceil(move.ply / 2),
                  san: move.san,
                })
              : t(`players.${color}`)
            : t("telemetry.initialTitle");
          const commentary = attempt?.commentary?.trim() ? attempt.commentary : null;
          const text = !color
            ? t("telemetry.initial")
            : !ai
              ? t("telemetry.humanMove")
              : !move
                ? t("telemetry.noMove")
                : !attempt
                  ? t(pending ? "telemetry.loading" : "telemetry.detailsUnavailable")
                  : (commentary ?? t("telemetry.missingCommentary"));
          return (
            <article
              key={color ?? "initial"}
              className="@container grid min-w-0 gap-1 border-b border-divider pb-2 last:border-0 last:pb-0"
            >
              <div className="grid min-h-target grid-cols-1 items-center gap-x-2 @min-[16rem]:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <h3 className="text-label font-semibold wrap-anywhere">{moveLabel}</h3>
                  <p
                    aria-hidden={!attempt}
                    className={cx("text-caption text-text-secondary", !attempt && "invisible")}
                  >
                    {t("telemetry.acceptedOn", { number: attempt?.attemptNumber ?? 1 })}
                  </p>
                </div>
                <Button
                  variant="quiet"
                  padding="compact"
                  className={cx(!ai && "invisible")}
                  aria-hidden={!ai}
                  aria-label={t("telemetry.readCommentary", { move: moveLabel })}
                  aria-haspopup="dialog"
                  aria-disabled={!ai || !commentary}
                  onClick={(event) => {
                    if (commentary && ai) {
                      event.currentTarget.focus({ preventScroll: true });
                      setReading({
                        gameId: details.snapshot.gameId,
                        move: moveLabel,
                        identity: `${t(`setup.providers.${seat.provider}`)} · ${seat.modelId}`,
                        commentary,
                      });
                    }
                  }}
                >
                  {t("telemetry.read")}
                </Button>
              </div>
              <div className="grid min-h-[2lh] min-w-0 text-label wrap-anywhere whitespace-pre-wrap text-text-secondary">
                {/* Translated empty/loading messages must fit without changing the preview's height. */}
                {previewMessages.map((message) => (
                  <span
                    key={message}
                    aria-hidden="true"
                    data-placeholder={t(`telemetry.${message}`)}
                    className="invisible min-w-0 [grid-area:1/1] before:content-[attr(data-placeholder)]"
                  />
                ))}
                <p
                  className={cx("min-w-0 self-start [grid-area:1/1]", commentary && "line-clamp-2")}
                >
                  {text}
                </p>
              </div>
              <dl
                aria-hidden={!ai}
                className={cx(
                  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-x-2 gap-y-1 text-label",
                  !ai && "invisible",
                )}
              >
                {commentaryMetrics.map((name) => {
                  const value = metricValue(attempt, name);
                  return (
                    <div key={name} className="min-w-0">
                      <dt className="text-text-secondary">{t(`telemetry.${name}`)}</dt>
                      <dd className="font-mono wrap-anywhere">
                        {value === null
                          ? t(
                              !move || (!attempt && pending)
                                ? "telemetry.pending"
                                : "telemetry.unavailable",
                            )
                          : name === "durationMs"
                            ? t("telemetry.milliseconds", { value: number.format(value) })
                            : number.format(value)}
                      </dd>
                    </div>
                  );
                })}
                <MoveCost
                  cost={move ? moveCost(records, move.ply) : null}
                  pending={!move || (!attempt && pending)}
                />
              </dl>
            </article>
          );
        })}
      </div>
      {reading?.gameId === details.snapshot.gameId ? (
        <Dialog
          title={t("telemetry.fullCommentary", { move: reading.move })}
          description={reading.identity}
          closeLabel={t("telemetry.closeCommentary")}
          onCancel={() => setReading(null)}
        >
          <p className="mt-4 text-body wrap-anywhere whitespace-pre-wrap">{reading.commentary}</p>
        </Dialog>
      ) : null}
    </section>
  );
}
