import { useTranslation } from "react-i18next";

import { Select } from "../../ui/select";

export function AiPacing({
  speed,
  onSpeed,
}: {
  readonly speed: number;
  readonly onSpeed: (speed: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="grid min-w-0 gap-2 text-label text-text-secondary sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
      {t("match.speed")}
      <Select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
        <option value={500}>{t("match.fast")}</option>
        <option value={1500}>{t("match.normal")}</option>
        <option value={5000}>{t("match.slow")}</option>
      </Select>
    </label>
  );
}
