import type { AiProvider } from "@neurochess/contracts";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";
import { Select } from "../ui/Select";

import { useCredentials } from "./context";

export function CredentialSelector({
  provider,
  source,
  credentialId,
  disabled,
  onSource,
  onSaved,
}: {
  readonly provider: AiProvider;
  readonly source: "session" | "saved";
  readonly credentialId: string;
  readonly disabled: boolean;
  readonly onSource: (source: "session" | "saved") => void;
  readonly onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const library = useCredentials();
  const id = useId();
  if (!library) return <p className="text-label text-text-secondary">{t("credentials.guest")}</p>;
  const { state, controller } = library;
  const records = state.credentials.filter((record) => record.provider === provider);
  return (
    <div className="grid min-w-0 gap-2 text-label">
      <label htmlFor={`${id}-source`}>{t("credentials.source")}</label>
      <Select
        id={`${id}-source`}
        value={source}
        aria-disabled={disabled}
        onChange={(event) => {
          if (!disabled) onSource(event.target.value === "saved" ? "saved" : "session");
        }}
      >
        <option value="session">{t("setup.sessionOnly")}</option>
        <option value="saved">{t("credentials.savedSource")}</option>
      </Select>
      {source === "saved" ? (
        <>
          <label htmlFor={`${id}-saved`}>{t("credentials.savedKey")}</label>
          <Select
            id={`${id}-saved`}
            value={credentialId}
            aria-disabled={disabled}
            onChange={(event) => {
              if (
                !disabled &&
                (!event.target.value ||
                  records.some((record) => record.credentialId === event.target.value))
              ) {
                onSaved(event.target.value);
              }
            }}
          >
            <option value="">{t("credentials.choose")}</option>
            {credentialId && !records.some((record) => record.credentialId === credentialId) ? (
              <option value={credentialId} disabled>
                {t("credentials.unlisted")}
              </option>
            ) : null}
            {records.map((record) => (
              <option key={record.credentialId} value={record.credentialId}>
                {record.label} ·{" "}
                {record.maskedSuffix ? `••••${record.maskedSuffix}` : t("credentials.masked")}
              </option>
            ))}
          </Select>
          <p>{t("credentials.referenceHint")}</p>
          {state.loading ? <p role="status">{t("credentials.loading")}</p> : null}
          {state.issue ? (
            <p role="alert" className="text-danger">
              {t(`credentials.errors.${state.issue}`)}
            </p>
          ) : !state.loading && !records.length ? (
            <p>{t("credentials.noProviderKeys")}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="quiet"
              aria-disabled={disabled || state.loading || state.busy}
              onClick={() => void controller.refresh()}
            >
              {t("credentials.refresh")}
            </Button>
            {state.nextCursor ? (
              <Button
                variant="quiet"
                aria-disabled={disabled || state.loading || state.busy}
                onClick={() => void controller.more()}
              >
                {t("credentials.more")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      <a
        href="/account#credentials"
        className="inline-flex min-h-target items-center text-accent underline"
      >
        {t("credentials.manage")}
      </a>
    </div>
  );
}
