import { useTranslation } from "react-i18next";

import { GameStatus as GameStatusPanel } from "../../arena/panels/GameStatus";
import { Button } from "../../ui/Button";
import type { SandboxController } from "../controller";
import { isTerminal, isUnfinished, type SandboxState } from "../state";
import { sandboxStatusPresentation } from "../statusPresentation";

import { CommandRecovery } from "./CommandRecovery";
import { LifecycleControls } from "./LifecycleControls";

type StatusController = Pick<
  SandboxController,
  "checkReadiness" | "lifecycle" | "recover" | "retryCommand" | "start" | "synchronize"
>;

export function GameStatus({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: StatusController;
}) {
  const { t } = useTranslation();
  const presentation = sandboxStatusPresentation(state, t);
  const busy = presentation.feedback?.activeId != null;
  const { snapshot } = state;
  return (
    <GameStatusPanel {...presentation}>
      <CommandRecovery state={state} controller={controller} />
      {snapshot && isUnfinished(snapshot) ? (
        <LifecycleControls key={snapshot.gameId} state={state} controller={controller} />
      ) : null}
      {snapshot && isTerminal(snapshot) ? (
        <Button
          variant="primary"
          className="mt-6"
          aria-disabled={busy || state.readiness !== "ready"}
          onClick={() => {
            void controller.start();
          }}
        >
          {t("actions.newGame")}
        </Button>
      ) : null}
    </GameStatusPanel>
  );
}
