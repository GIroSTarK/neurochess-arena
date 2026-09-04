import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import type { SandboxController } from "../controller";
import type { SandboxPhase, SandboxState } from "../state";

type StartLabel =
  "actions.start" | "actions.starting" | "actions.retryStart" | "actions.restartSession";

/** Phases whose label explains a retry or a fresh session; every other phase offers Start. */
const phaseLabels: Partial<Record<SandboxPhase, StartLabel>> = {
  starting: "actions.starting",
  unavailable: "actions.retryStart",
  "access-error": "actions.restartSession",
};

/** The only action that bootstraps a guest. */
export function StartButton({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<SandboxController, "start">;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="primary"
      className="mt-8"
      aria-disabled={
        state.readiness !== "ready" ||
        !["entry", "access-error", "unavailable"].includes(state.phase)
      }
      onClick={() => {
        void controller.start();
      }}
    >
      {t(phaseLabels[state.phase] ?? "actions.start")}
      <Icon path="M5 12h14m-6-6 6 6-6 6" />
    </Button>
  );
}
