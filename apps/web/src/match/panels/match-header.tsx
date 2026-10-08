import { ArenaHeader } from "../../arena/arena-header";
import { StatusSummary } from "../../arena/status-summary";
import type { MatchPresentation } from "../presentation";

export function MatchHeader({ view }: { readonly view: MatchPresentation["header"] }) {
  return (
    <ArenaHeader
      title={view.title}
      description={view.status ? <StatusSummary {...view.status} /> : view.description}
      score={
        view.result ? (
          <span data-testid="game-score" className="font-display text-title">
            <span className="sr-only">{view.result.scoreLabel}</span>
            <span aria-hidden="true">{view.result.score}</span>
          </span>
        ) : undefined
      }
    />
  );
}
