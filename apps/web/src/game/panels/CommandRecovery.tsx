import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import type { SandboxController } from "../controller";
import type { SandboxState } from "../state";

export function CommandRecovery({
  state,
  controller,
  onRetryRecovery,
  onRetryConnection,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<
    SandboxController,
    "recover" | "retryCommand" | "synchronize" | "checkReadiness"
  >;
  readonly onRetryRecovery?: () => void;
  readonly onRetryConnection?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {state.phase === "uncertain" || state.phase === "sync-required" ? (
        <div className="flex flex-col items-stretch gap-3">
          <p className="text-text-secondary">{t("game.uncertainHint")}</p>
          {state.phase === "uncertain" ? (
            <Button
              variant="primary"
              onClick={() => {
                void controller.retryCommand();
              }}
            >
              {t("action" in state.pendingCommand ? "actions.retryCommand" : "actions.retryMove")}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => {
              void controller.synchronize();
            }}
          >
            {t("actions.synchronize")}
          </Button>
        </div>
      ) : null}
      {state.phase === "recovery-required" ? (
        <Button
          variant="primary"
          onClick={() => {
            if (onRetryRecovery) onRetryRecovery();
            else void controller.recover();
          }}
        >
          {t("actions.retryRecovery")}
        </Button>
      ) : null}
      {state.readiness === "unavailable" ? (
        <Button
          variant="secondary"
          onClick={() => {
            if (onRetryConnection) onRetryConnection();
            else void controller.checkReadiness();
          }}
        >
          {t("actions.retryConnection")}
        </Button>
      ) : null}
    </>
  );
}
