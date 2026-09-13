import { useTranslation } from "react-i18next";

import { cx } from "../ui/cx";
import { Icon } from "../ui/Icon";

type ServiceState = "checking" | "ready" | "unavailable";

const connectionMarks: Record<ServiceState, string> = {
  checking: "border-current",
  ready: "border-success bg-success text-canvas",
  unavailable: "border-current text-warning",
};

export function ServiceStatus({
  state,
  compact = false,
}: {
  readonly state: ServiceState;
  readonly compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cx(
        "flex shrink-0 items-center gap-2",
        compact ? "text-caption" : "text-label",
        compact && state === "ready" ? "text-success" : "text-text-secondary",
      )}
      aria-label={t("connection.label")}
    >
      <span
        className={cx(
          "inline-grid shrink-0 place-items-center rounded-full border font-semibold",
          compact ? "size-4" : "size-5",
          connectionMarks[state],
        )}
        aria-hidden="true"
      >
        <Icon
          size={compact ? "xs" : "sm"}
          path={
            state === "ready"
              ? "m5 12 4 4L19 6"
              : state === "checking"
                ? "M6 12h.01M12 12h.01M18 12h.01"
                : "M12 6v8m0 4h.01"
          }
        />
      </span>
      <span>{t(`connection.${state}`)}</span>
    </div>
  );
}
