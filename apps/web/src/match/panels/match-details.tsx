import { useTranslation } from "react-i18next";

import { ArenaDetails } from "../../arena/arena-details";
import { EvaluationPanel } from "../../arena/panels/evaluation-panel";
import { MoveHistory } from "../../arena/panels/move-history";
import type { EvaluationView } from "../../gameplay/analysis-controller";
import { Button } from "../../ui/button";
import { StableText } from "../../ui/stable-text";
import { CommentaryPanel } from "../commentary-panel";
import type { MatchController } from "../controller";
import { InvocationEvents } from "../invocation-events";
import type { MatchPresentation } from "../presentation";
import type { MatchState } from "../state";
import { TelemetryPanel } from "../telemetry-panel";

export function MatchDetails({
  state,
  view,
  controller,
  evaluation,
}: {
  readonly state: MatchState;
  readonly view: MatchPresentation;
  readonly controller: MatchController;
  readonly evaluation?: { readonly view: EvaluationView; readonly onRetrySave: () => void };
}) {
  const { t } = useTranslation();
  const { details } = state;
  if (!details?.configuration || details.configuration.mode === "human_vs_human") return null;
  const { snapshot } = details;
  return (
    <ArenaDetails
      commentary={
        <CommentaryPanel
          key={snapshot.gameId}
          details={details}
          records={state.invocations}
          selectedPly={
            view.terminal ? (state.replay ? state.replayPly : snapshot.moves.length) : null
          }
          loading={state.invocationsLoading}
          error={state.invocationsError}
        />
      }
      analysis={
        <div className="grid gap-6">
          {evaluation ? (
            <EvaluationPanel
              view={evaluation.view}
              selectedPly={state.replay ? state.replayPly : snapshot.moves.length}
              moves={snapshot.moves}
              onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
              onRetrySave={evaluation.onRetrySave}
            />
          ) : null}
          <TelemetryPanel
            details={details}
            records={state.invocations}
            recordedMoveCount={state.invocationsMoveCount}
            loading={state.invocationsLoading}
            error={state.invocationsError}
            onRefresh={() => {
              void controller.loadInvocations();
            }}
          />
        </div>
      }
      events={
        <InvocationEvents
          records={state.invocations}
          snapshot={snapshot}
          loading={state.invocationsLoading}
          error={state.invocationsError}
        />
      }
      moves={
        <MoveHistory
          showHeading={false}
          moves={snapshot.moves}
          selectedPly={state.replay ? state.replayPly : undefined}
          onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
        />
      }
    >
      <div className="grid shrink-0 gap-4 border-t border-divider pt-4 text-body">
        {view.details.message !== null &&
        (!state.issue || (state.issue.kind === "notice" && state.issue.code === "recovered")) ? (
          <p className="text-text-secondary">
            <StableText value={view.details.message} variants={view.details.variants} />
          </p>
        ) : null}
        {view.terminal ? (
          <Button variant="primary" onClick={() => controller.newGame()}>
            {t("match.newGame")}
          </Button>
        ) : null}
      </div>
    </ArenaDetails>
  );
}
