import { useTranslation } from "react-i18next";

import { cx } from "../ui/cx";

type ServiceState = "checking" | "ready" | "unavailable";

const connectionMarks: Record<ServiceState, string> = {
  checking: "",
  ready: "text-success",
  unavailable: "text-warning",
};

export function ServiceStatus({ state }: { readonly state: ServiceState }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex shrink-0 items-center gap-2 text-label text-text-secondary"
      aria-label={t("connection.label")}
    >
      <span
        className={cx(
          "inline-grid size-5 shrink-0 place-items-center rounded-full border border-current font-semibold",
          connectionMarks[state],
        )}
        aria-hidden="true"
      >
        {state === "ready" ? "✓" : state === "checking" ? "…" : "!"}
      </span>
      <span>{t(`connection.${state}`)}</span>
    </div>
  );
}
