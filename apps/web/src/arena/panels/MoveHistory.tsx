import type { MoveRecord } from "@neurochess/contracts";
import { useId, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../../ui/cx";

interface MoveHistoryProps {
  readonly moves: readonly MoveRecord[];
  readonly selectedPly?: number | undefined;
  readonly onSelect?: ((ply: number) => void) | undefined;
  readonly variant?: "panel" | "rail";
  readonly showHeading?: boolean;
}

const cellClassName = "border-b border-divider wrap-anywhere";

const currentMoveClassName =
  "aria-[current]:bg-surface-raised aria-[current]:font-semibold aria-[current]:text-accent aria-[current]:shadow-[inset_2px_0_0_var(--color-accent)]";

export function MoveHistory({
  moves,
  selectedPly,
  onSelect,
  variant = "panel",
  showHeading = true,
}: MoveHistoryProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const language = i18n.resolvedLanguage ?? "en";
  const moveNumber = useMemo(() => new Intl.NumberFormat(language), [language]);
  const scroller = useRef<HTMLDivElement>(null);
  const tableHead = useRef<HTMLTableSectionElement>(null);
  const selectedMove = useRef<HTMLButtonElement>(null);
  const followLatest = useRef(true);
  const rows = [];
  for (let index = 0; index < moves.length; index += 2) {
    rows.push({ number: index / 2 + 1, white: moves[index], black: moves[index + 1] });
  }
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (selectedPly === undefined) {
      if (followLatest.current) element.scrollTop = element.scrollHeight;
      return;
    }
    if (selectedPly === 0) {
      element.scrollTop = 0;
      return;
    }
    const target = selectedMove.current;
    if (!target) return;
    const viewport = element.getBoundingClientRect();
    const selection = target.getBoundingClientRect();
    // Scroll only this panel, clearing the sticky header and the 2px focus ring's 3px offset.
    const top =
      viewport.top +
      element.clientTop +
      (tableHead.current?.getBoundingClientRect().height ?? 0) +
      5;
    const bottom = viewport.top + element.clientTop + element.clientHeight - 5;
    if (selection.top < top) element.scrollTop += selection.top - top;
    else if (selection.bottom > bottom) element.scrollTop += selection.bottom - bottom;
  }, [moves.length, selectedPly]);

  function notation(move: MoveRecord | undefined) {
    if (!move) {
      return (
        <span
          className={cx("block px-2 py-3 text-text-muted", variant === "rail" && "text-center")}
          aria-label={t("moves.pending")}
        >
          —
        </span>
      );
    }
    if (onSelect) {
      return (
        <button
          ref={move.ply === selectedPly ? selectedMove : undefined}
          type="button"
          className={cx(
            "block min-h-target min-w-target bg-transparent px-[min(0.5rem,8px)] py-2",
            variant === "rail"
              ? "w-full text-center hover:bg-surface-raised focus-visible:-outline-offset-2"
              : "rounded-control border border-transparent text-start aria-[current]:border-accent",
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
        className={cx(
          "block px-[min(0.5rem,8px)] py-3",
          currentMoveClassName,
          variant === "rail" && "text-center",
        )}
        aria-current={move.ply === moves.length ? "true" : undefined}
      >
        {move.san}
        {move.ply === moves.length ? <span className="sr-only"> · {t("moves.latest")}</span> : null}
      </span>
    );
  }

  return (
    <section
      className={cx("min-w-0", variant === "rail" && "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col")}
      aria-labelledby={headingId}
    >
      <div
        className={
          showHeading
            ? cx(
                "flex shrink-0 flex-wrap items-center justify-between gap-3",
                variant === "rail"
                  ? "border-b border-divider pb-2"
                  : "border-b-2 border-accent pb-3",
              )
            : "sr-only"
        }
      >
        <h2
          id={headingId}
          className={cx(
            "text-section font-semibold",
            variant === "rail" &&
              "relative after:absolute after:-bottom-[9px] after:left-0 after:h-0.5 after:w-18 after:bg-accent",
          )}
        >
          {t("moves.title")}
        </h2>
        <span className="text-right text-label text-text-muted">
          {t("moves.count", { count: moves.length })}
        </span>
      </div>
      <div
        ref={scroller}
        className={cx(
          "mt-2 max-h-112 [scrollbar-color:var(--color-control-border)_var(--color-surface)] [scrollbar-gutter:stable] overflow-auto",
          // Table rows must not determine the arena's height; the play area supplies its space.
          variant === "rail" && "lg:max-h-none lg:min-h-0 lg:flex-1 lg:contain-size",
        )}
        role="region"
        aria-label={t("moves.scrollLabel")}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          followLatest.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        <table
          className={cx(
            "w-full table-fixed border-collapse text-left",
            variant === "rail" && "text-label",
          )}
        >
          <caption className="sr-only">{t("moves.caption")}</caption>
          <thead ref={tableHead} className="sticky top-0 z-1 bg-canvas">
            <tr>
              <th
                scope="col"
                className={cx(
                  cellClassName,
                  "px-[min(0.5rem,8px)] py-3 text-label font-normal text-text-secondary",
                  variant === "rail" ? "w-[20%]" : "w-[30%]",
                )}
              >
                {t("moves.number")}
              </th>
              <th
                scope="col"
                className={cx(
                  cellClassName,
                  "px-[min(0.5rem,8px)] py-3 text-label font-normal text-text-secondary",
                  variant === "rail" && "border-l border-divider text-center",
                )}
              >
                {t("players.white")}
              </th>
              <th
                scope="col"
                className={cx(
                  cellClassName,
                  "px-[min(0.5rem,8px)] py-3 text-label font-normal text-text-secondary",
                  variant === "rail" && "border-l border-divider text-center",
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
                  <td
                    className={cx(
                      cellClassName,
                      "p-0 font-mono",
                      variant === "rail" && "border-l border-divider",
                    )}
                  >
                    {notation(row.white)}
                  </td>
                  <td
                    className={cx(
                      cellClassName,
                      "p-0 font-mono",
                      variant === "rail" && "border-l border-divider",
                    )}
                  >
                    {notation(row.black)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
