import { useTranslation } from "react-i18next";

import { StartButton as StartControl } from "../../arena/panels/StartButton";
import { isTerminal } from "../../gameplay/snapshot";
import type { SandboxController } from "../controller";
import type { SandboxPhase, SandboxState } from "../state";

type StartLabel =
  "actions.start" | "actions.starting" | "actions.retryStart" | "actions.restartSession";

const phaseLabels: Partial<Record<SandboxPhase, StartLabel>> = {
  starting: "actions.starting",
  unavailable: "actions.retryStart",
  "access-error": "actions.restartSession",
};

export function SandboxStartButton({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<SandboxController, "start">;
}) {
  const { t } = useTranslation();
  const terminal = state.snapshot !== null && isTerminal(state.snapshot);
  return (
    <StartControl
      label={t(terminal ? "actions.newGame" : (phaseLabels[state.phase] ?? "actions.start"))}
      variant={terminal ? "secondary" : "primary"}
      disabled={
        state.readiness !== "ready" ||
        (terminal
          ? state.phase !== "ready"
          : !["entry", "access-error", "unavailable"].includes(state.phase))
      }
      onStart={() => {
        void controller.start();
      }}
    />
  );
}
