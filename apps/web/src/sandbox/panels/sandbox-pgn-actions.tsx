import { useTranslation } from "react-i18next";

import { PgnActions as PgnPanel } from "../../arena/panels/pgn-actions";
import type { SandboxController } from "../controller";
import { noticeMessage } from "../messages";
import type { SandboxState } from "../state";

export function SandboxPgnActions({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: Pick<SandboxController, "exportPgn">;
}) {
  const { t } = useTranslation();
  return (
    <PgnPanel
      busy={state.exportPhase === "loading"}
      feedback={
        state.exportPhase !== "idle" && state.exportPhase !== "error"
          ? t(`export.${state.exportPhase}`)
          : null
      }
      error={state.exportNotice ? noticeMessage(state.exportNotice, t) : null}
      text={state.exportText}
      onExport={(kind) => {
        void controller.exportPgn(kind);
      }}
    />
  );
}
