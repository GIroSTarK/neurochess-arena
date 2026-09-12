import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";

export function PgnActions({
  busy,
  feedback,
  error,
  text,
  onExport,
}: {
  readonly busy: boolean;
  readonly feedback: string | null;
  readonly error: string | null;
  readonly text: string | null;
  readonly onExport: (kind: "copy" | "download") => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      className="min-w-0 rounded-control border border-control-border bg-surface p-4"
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="text-label font-semibold">
        {t("export.title")}
      </h2>
      <div className="my-4 flex flex-wrap gap-3">
        <Button
          variant="secondary"
          className="flex-[1_1_8rem]"
          aria-disabled={busy}
          onClick={() => {
            onExport("copy");
          }}
        >
          {t("export.copy")}
        </Button>
        <Button
          variant="secondary"
          className="flex-[1_1_8rem]"
          aria-disabled={busy}
          onClick={() => {
            onExport("download");
          }}
        >
          {t("export.download")}
        </Button>
      </div>
      {feedback ? <p className="mt-3">{feedback}</p> : null}
      {error ? <p className="mt-3">{error}</p> : null}
      {text ? (
        <label className="mt-3 grid gap-2">
          {t("export.text")}
          <textarea
            className="min-h-32 w-full resize-y rounded-control border border-control-border bg-canvas p-3 text-text"
            readOnly
            rows={8}
            value={text}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
    </section>
  );
}
