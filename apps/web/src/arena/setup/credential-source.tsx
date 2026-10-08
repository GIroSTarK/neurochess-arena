import type { AiProvider, CredentialMetadata } from "@neurochess/contracts";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/button";
import { Select } from "../../ui/select";

export interface SavedCredentialChoices {
  readonly credentials: readonly CredentialMetadata[];
  readonly phase: "loading" | "ready" | "error";
  readonly onRefresh: () => void;
}
export function CredentialSource({
  provider,
  value,
  saved,
  disabled,
  label,
  onChange,
}: {
  readonly provider: AiProvider;
  readonly value: string;
  readonly saved: SavedCredentialChoices;
  readonly disabled: boolean;
  readonly label?: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const choices = saved.credentials.filter((item) => item.provider === provider);
  return (
    <div className="grid min-w-0 gap-2 text-label">
      <label htmlFor={id}>{label ?? t("credentials.source")}</label>
      <Select
        id={id}
        value={value}
        aria-disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          if (!disabled) onChange(event.target.value);
        }}
      >
        <option value="session">{t("setup.sessionOnly")}</option>
        {value !== "session" && !choices.some((item) => item.credentialId === value) ? (
          <option value={value} disabled>
            {t("credentials.missingSelection")}
          </option>
        ) : null}
        {choices.map((item) => (
          <option key={item.credentialId} value={item.credentialId}>
            {t("credentials.savedOption", {
              label: item.label,
              suffix: item.maskedSuffix
                ? t("credentials.suffix", { suffix: item.maskedSuffix })
                : t("credentials.masked"),
            })}
          </option>
        ))}
      </Select>
      <p id={`${id}-hint`} className="text-text-secondary">
        {t(
          saved.phase === "error"
            ? "credentials.loadError"
            : saved.phase === "loading"
              ? "account.loading"
              : "credentials.selectHint",
        )}
      </p>
      {saved.phase === "error" ? (
        <Button variant="secondary" onClick={saved.onRefresh}>
          {t("credentials.refresh")}
        </Button>
      ) : null}
    </div>
  );
}
