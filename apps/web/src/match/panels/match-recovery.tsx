import type { CredentialMetadata } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import type { SavedCredentialChoices } from "../../arena/setup/credential-source";
import { Button } from "../../ui/button";
import type { MatchController } from "../controller";
import { PausedCredentials } from "../paused-credentials";
import type { MatchPresentation } from "../presentation";
import type { MatchState } from "../state";

export function MatchRecovery({
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
  const { details, issue } = state;
  if (!details?.configuration || details.configuration.mode === "human_vs_human") return null;
  const credentialFailure = issue?.kind === "provider" && issue.error.code === "provider_auth";
  const message =
    credentialFailure || (issue?.kind === "notice" && issue.code === "recovered")
      ? null
      : view.issueText;
  const providerContinuation =
    issue?.kind === "provider" &&
    !credentialFailure &&
    state.phase === "ready" &&
    details.snapshot.state === "paused";

  return (
    <>
      {message || state.phase === "uncertain" ? (
        <div className="grid gap-3 border-l-2 border-warning bg-surface p-3 text-label">
          {message ? <p>{message}</p> : null}
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
          ) : providerContinuation ? (
            <Button
              variant="secondary"
              className="justify-self-start"
              aria-disabled={view.controls.busy || !view.controls.canContinue}
              onClick={() => {
                void controller.resume();
              }}
            >
              {t("match.retryProvider")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <PausedCredentials
        {...view.credentials}
        seats={details.configuration.seats}
        {...(savedCredentials ? { savedCredentials } : {})}
        onCredentialChange={(color, value) => controller.setCredential(color, value, credentials)}
        onKeyChange={(color, value) => controller.setKey(color, value)}
        onResume={() => {
          void controller.resume();
        }}
      />
    </>
  );
}
