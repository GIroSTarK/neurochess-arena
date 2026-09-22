import { useTranslation } from "react-i18next";

import { StableText } from "../ui/StableText";

export function TelemetryStatus({
  hasRecords,
  loading,
  error,
  stale,
}: {
  readonly hasRecords: boolean;
  readonly loading: boolean;
  readonly error: boolean;
  readonly stale: boolean;
}) {
  const { t } = useTranslation();
  const message = error
    ? hasRecords
      ? "telemetry.refreshError"
      : "telemetry.loadError"
    : !hasRecords
      ? "telemetry.loading"
      : loading || stale
        ? "telemetry.updating"
        : "telemetry.current";
  return (
    <p className="text-label text-text-secondary">
      <StableText
        value={t(message)}
        variants={[
          t("telemetry.loading"),
          t("telemetry.updating"),
          t("telemetry.current"),
          t("telemetry.refreshError"),
          t("telemetry.loadError"),
        ]}
      />
    </p>
  );
}
