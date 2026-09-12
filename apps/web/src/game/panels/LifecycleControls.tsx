import { LifecycleControls as LifecyclePanel } from "../../arena/panels/LifecycleControls";
import type { SandboxController } from "../controller";
import { interactionEpoch, type SandboxState } from "../state";

export function LifecycleControls({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<SandboxController, "lifecycle">;
}) {
  return (
    <LifecyclePanel
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
      resignations={(["white", "black"] as const).map((color) => ({
        color,
        onResign: () => {
          void controller.lifecycle({ action: "resign", losingColor: color });
        },
      }))}
    />
  );
}
