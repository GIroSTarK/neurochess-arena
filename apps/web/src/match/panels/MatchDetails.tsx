import type { CredentialMetadata } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { ArenaDetails } from "../../arena/ArenaDetails";
import { MoveHistory } from "../../arena/panels/MoveHistory";
import type { SavedCredentialChoices } from "../../arena/setup/CredentialSource";
import { Button } from "../../ui/Button";
import { StableText } from "../../ui/StableText";
import { CommentaryPanel } from "../CommentaryPanel";
import type { MatchController } from "../controller";
import { InvocationEvents } from "../InvocationEvents";
import { PausedCredentials } from "../PausedCredentials";
import type { MatchPresentation } from "../presentation";
import type { MatchState } from "../state";
import { TelemetryPanel } from "../TelemetryPanel";

export function MatchDetails({
  state,
  view,
  controller,
  credentials,
  savedCredentials,
}: {
  readonly state: MatchState;
  readonly view: MatchPresentation;
  readonly controller: MatchController;
  readonly credentials: readonly CredentialMetadata[];
  readonly savedCredentials?: SavedCredentialChoices;
}) {
  const { t } = useTranslation();
  const { details } = state;
  if (!details?.configuration) return null;
  const { snapshot, configuration } = details;
  return (
    <PausedCredentials
      {...view.credentials}
      seats={configuration.seats}
      {...(savedCredentials ? { savedCredentials } : {})}
      onCredentialChange={(color, value) => controller.setCredential(color, value, credentials)}
      onKeyChange={(color, value) => controller.setKey(color, value)}
      onResume={() => {
        void controller.continue(false);
      }}
    >
      <ArenaDetails
        commentary={
          <CommentaryPanel
            key={snapshot.gameId}
            details={details}
            records={state.invocations}
            selectedPly={view.terminal ? state.replayPly : null}
            loading={state.invocationsLoading}
            error={state.invocationsError}
          />
        }
        analysis={
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
          {view.details.message !== null ? (
            <p className="text-text-secondary">
              <StableText value={view.details.message} variants={view.details.variants} />
            </p>
          ) : null}
          {state.phase === "uncertain" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                aria-disabled={state.busy}
                onClick={() => {
                  void controller.recover();
                }}
              >
                {t("match.recover")}
              </Button>
              {state.pendingControl ? (
                <Button
                  variant="secondary"
                  aria-disabled={state.busy}
                  onClick={() => {
                    void controller.retryControl();
                  }}
                >
                  {t("match.retryControl")}
                </Button>
              ) : null}
              {state.pendingMove ? (
                <Button
                  variant="secondary"
                  aria-disabled={state.busy}
                  onClick={() => {
                    void controller.retryMove();
                  }}
                >
                  {t("match.retryMove")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {view.terminal ? (
            <Button variant="primary" onClick={() => controller.newGame()}>
              {t("match.newGame")}
            </Button>
          ) : null}
        </div>
      </ArenaDetails>
    </PausedCredentials>
  );
}
