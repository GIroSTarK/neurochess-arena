import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

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
    <section className="mt-4 min-w-0" aria-labelledby={headingId}>
      <h2 id={headingId} className="sr-only">
        {t("export.title")}
      </h2>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          className="flex-[1_1_8rem] wrap-normal"
          aria-disabled={busy}
          onClick={() => {
            onExport("copy");
          }}
        >
          <Icon path="M9 9h11v12H9zM15 9V3H3v12h6" />
          {t("export.copy")}
        </Button>
        <Button
          variant="primary"
          className="flex-[1_1_8rem] wrap-normal"
          aria-disabled={busy}
          onClick={() => {
            onExport("download");
          }}
        >
          <Icon path="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6" />
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
