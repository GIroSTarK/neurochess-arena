import { useTranslation } from "react-i18next";

import {
  LifecycleControls as LifecyclePanel,
  type LifecycleControlsProps,
} from "../../arena/panels/LifecycleControls";
import type { SandboxController } from "../controller";
import { interactionEpoch, type SandboxState } from "../state";

export function LifecycleControls({
  state,
  controller,
  boardTools,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<SandboxController, "lifecycle">;
  readonly boardTools: LifecycleControlsProps["boardTools"];
}) {
  const { t } = useTranslation();
  return (
    <LifecyclePanel
      boardTools={boardTools}
      paused={state.snapshot?.state === "paused"}
      disabled={state.phase !== "ready"}
      epoch={interactionEpoch(state)}
      onTogglePause={() => {
        void controller.lifecycle({
          action: state.snapshot?.state === "paused" ? "resume" : "pause",
        });
      }}
      onAbort={() => {
        void controller.lifecycle({ action: "abort" });
      }}
      abortDescription={t("sandbox.abortDescription")}
      resignations={(["white", "black"] as const).map((color) => ({
        color,
        onResign: () => {
          void controller.lifecycle({ action: "resign", losingColor: color });
        },
      }))}
    />
  );
}
