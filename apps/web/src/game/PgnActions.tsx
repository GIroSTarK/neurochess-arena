import { useTranslation } from "react-i18next";

import { noticeMessage } from "../i18n/messages";
import { Button } from "../ui/Button";

import type { SandboxController, SandboxState } from "./controller";

export function PgnActions({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="min-w-0 rounded-control border border-control-border bg-surface p-4"
      aria-labelledby="pgn-heading"
    >
      <h2 id="pgn-heading" className="text-label font-semibold">
        {t("export.title")}
      </h2>
      <div className="my-4 flex flex-wrap gap-3">
        <Button
          variant="secondary"
          className="flex-[1_1_8rem]"
          aria-disabled={state.exportPhase === "loading"}
          onClick={() => {
            void controller.exportPgn("copy");
          }}
        >
          {t("export.copy")}
        </Button>
        <Button
          variant="secondary"
          className="flex-[1_1_8rem]"
          aria-disabled={state.exportPhase === "loading"}
          onClick={() => {
            void controller.exportPgn("download");
          }}
        >
          {t("export.download")}
        </Button>
      </div>
      {state.exportPhase !== "idle" && state.exportPhase !== "error" ? (
        <p className="mt-3">{t(`export.${state.exportPhase}`)}</p>
      ) : null}
      {state.archiveNotice ? <p className="mt-3">{noticeMessage(state.archiveNotice, t)}</p> : null}
      {state.exportText ? (
        <label className="mt-3 grid gap-2">
          {t("export.text")}
          <textarea
            className="min-h-32 w-full resize-y rounded-control border border-control-border bg-canvas p-3 text-text"
            readOnly
            rows={8}
            value={state.exportText}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
    </section>
  );
}
