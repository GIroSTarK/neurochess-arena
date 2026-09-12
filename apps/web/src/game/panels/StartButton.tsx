import { useTranslation } from "react-i18next";

import { StartButton as StartControl } from "../../arena/panels/StartButton";
import type { SandboxController } from "../controller";
import type { SandboxPhase, SandboxState } from "../state";

type StartLabel =
  "actions.start" | "actions.starting" | "actions.retryStart" | "actions.restartSession";

const phaseLabels: Partial<Record<SandboxPhase, StartLabel>> = {
  starting: "actions.starting",
  unavailable: "actions.retryStart",
  "access-error": "actions.restartSession",
};

export function StartButton({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<SandboxController, "start">;
}) {
  const { t } = useTranslation();
  return (
    <StartControl
      label={t(phaseLabels[state.phase] ?? "actions.start")}
      disabled={
        state.readiness !== "ready" ||
        !["entry", "access-error", "unavailable"].includes(state.phase)
      }
      onStart={() => {
        void controller.start();
      }}
    />
  );
}
