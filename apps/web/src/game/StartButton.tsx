import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

import type { SandboxController, SandboxState } from "./controller";

/** The only action that bootstraps a guest; its label explains a retry or a fresh session. */
export function StartButton({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: SandboxController;
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
      {t(
        state.phase === "starting"
          ? "actions.starting"
          : state.phase === "unavailable"
            ? "actions.retryStart"
            : state.phase === "access-error"
              ? "actions.restartSession"
              : "actions.start",
      )}
      <Icon path="M5 12h14m-6-6 6 6-6 6" />
    </Button>
  );
}
