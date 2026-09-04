import type { MoveRecord } from "@neurochess/contracts";
import { useId, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../../ui/cx";

interface MoveHistoryProps {
  readonly moves: readonly MoveRecord[];
  readonly selectedPly?: number | undefined;
  readonly onSelect?: ((ply: number) => void) | undefined;
}

const cellClassName = "border-b border-divider wrap-anywhere";

const currentMoveClassName =
  "aria-[current]:bg-surface-raised aria-[current]:font-semibold aria-[current]:text-accent aria-[current]:shadow-[inset_2px_0_0_var(--color-accent)]";

export function MoveHistory({ moves, selectedPly, onSelect }: MoveHistoryProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const language = i18n.resolvedLanguage ?? "en";
  const moveNumber = useMemo(() => new Intl.NumberFormat(language), [language]);
  const scroller = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const rows = [];
  for (let index = 0; index < moves.length; index += 2) {
    rows.push({ number: index / 2 + 1, white: moves[index], black: moves[index + 1] });
  }
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && followLatest.current) element.scrollTop = element.scrollHeight;
  }, [moves.length]);

  function notation(move: MoveRecord | undefined) {
    if (!move) {
      return (
        <span className="block px-2 py-3 text-text-muted" aria-label={t("moves.pending")}>
          —
        </span>
      );
    }
    if (onSelect) {
      return (
        <button
          type="button"
          className={cx(
            "block min-h-target min-w-target rounded-control border border-transparent bg-transparent p-2 text-start aria-[current]:border-accent",
            currentMoveClassName,
          )}
          aria-current={move.ply === selectedPly ? "step" : undefined}
          aria-label={t("replay.selectMove", { ply: move.ply, move: move.san })}
          onClick={() => onSelect(move.ply)}
        >
          {move.san}
        </button>
      );
    }
    return (
      <span
        className={cx("block px-2 py-3", currentMoveClassName)}
        aria-current={move.ply === moves.length ? "true" : undefined}
      >
        {move.san}
        {move.ply === moves.length ? <span className="sr-only"> · {t("moves.latest")}</span> : null}
      </span>
    );
  }

  return (
    <section className="min-w-0" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-accent pb-3">
        <h2 id={headingId} className="text-section font-semibold">
          {t("moves.title")}
        </h2>
        <span className="text-right text-label text-text-muted">
          {t("moves.count", { count: moves.length })}
        </span>
      </div>
      <div
        ref={scroller}
        className="mt-2 max-h-112 [scrollbar-color:var(--color-control-border)_var(--color-surface)] [scrollbar-gutter:stable] overflow-auto overscroll-contain"
        role="region"
        aria-label={t("moves.scrollLabel")}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          followLatest.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        <table className="w-full table-fixed border-collapse text-left">
          <caption className="sr-only">{t("moves.caption")}</caption>
          <thead className="sticky top-0 z-1 bg-canvas">
            <tr>
              <th
                scope="col"
                className={cx(
                  cellClassName,
                  "w-[30%] px-[min(0.5rem,8px)] py-3 text-label font-normal text-text-secondary",
                )}
              >
                {t("moves.number")}
              </th>
              <th
                scope="col"
                className={cx(
                  cellClassName,
                  "px-[min(0.5rem,8px)] py-3 text-label font-normal text-text-secondary",
                )}
              >
                {t("players.white")}
              </th>
              <th
                scope="col"
                className={cx(
                  cellClassName,
                  "px-[min(0.5rem,8px)] py-3 text-label font-normal text-text-secondary",
                )}
              >
                {t("players.black")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className={cx(cellClassName, "px-2 py-6 text-text-secondary")}>
                  <p>{t("moves.empty")}</p>
                  <p className="mt-2 text-label text-text-muted">{t("moves.emptyHint")}</p>
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.number}>
                  <th
                    scope="row"
                    className={cx(
                      cellClassName,
                      "px-2 py-3 font-mono text-label font-normal text-text-muted",
                    )}
                  >
                    {moveNumber.format(row.number)}.
                  </th>
                  <td className={cx(cellClassName, "p-0 font-mono")}>{notation(row.white)}</td>
                  <td className={cx(cellClassName, "p-0 font-mono")}>{notation(row.black)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
