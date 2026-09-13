import { useTranslation } from "react-i18next";

import { ReplayControls as ReplayPanel } from "../../arena/panels/ReplayControls";
import type { SandboxController } from "../controller";
import { noticeMessage } from "../messages";
import type { SandboxState } from "../state";

export function ReplayControls({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<SandboxController, "loadReplay" | "selectPly">;
}) {
  const { t } = useTranslation();
  const count = state.replay?.snapshot.moves.length ?? state.snapshot?.moves.length ?? 0;
  return (
    <ReplayPanel
      available={state.replay !== null}
      loading={state.replayPhase === "loading"}
      count={count}
      ply={state.replay ? state.replayPly : count}
      notice={state.replayNotice ? noticeMessage(state.replayNotice, t) : null}
      onSelect={(ply) => controller.selectPly(ply)}
      onRetry={
        state.replayPhase === "error"
          ? () => {
              void controller.loadReplay();
            }
          : null
      }
    />
  );
}
