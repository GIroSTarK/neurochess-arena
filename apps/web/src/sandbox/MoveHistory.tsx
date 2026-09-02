import type { MoveRecord } from "@neurochess/contracts";
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface MoveHistoryProps {
  readonly moves: readonly MoveRecord[];
}

export function MoveHistory({ moves }: MoveHistoryProps) {
  const { t, i18n } = useTranslation();
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
    if (!move)
      return (
        <span className="empty-ply" aria-label={t("moves.pending")}>
          —
        </span>
      );
    return (
      <span className="move-notation" aria-current={move.ply === moves.length ? "true" : undefined}>
        {move.san}
        {move.ply === moves.length ? <span className="sr-only"> · {t("moves.latest")}</span> : null}
      </span>
    );
  }

  return (
    <section className="move-history" aria-labelledby="moves-heading">
      <div className="section-heading">
        <h2 id="moves-heading">{t("moves.title")}</h2>
        <span>{t("moves.count", { count: moves.length })}</span>
      </div>
      <div
        ref={scroller}
        className="move-history__scroll"
        role="region"
        aria-label={t("moves.scrollLabel")}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          followLatest.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        <table>
          <caption className="sr-only">{t("moves.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("moves.number")}</th>
              <th scope="col">{t("players.white")}</th>
              <th scope="col">{t("players.black")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="move-history__empty">
                  <p>{t("moves.empty")}</p>
                  <p>{t("moves.emptyHint")}</p>
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.number}>
                  <th scope="row">
                    {new Intl.NumberFormat(i18n.resolvedLanguage ?? "en").format(row.number)}.
                  </th>
                  <td>{notation(row.white)}</td>
                  <td>{notation(row.black)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
