import {
  type AiProvider,
  aiProviderSchema,
  type CredentialMetadata,
  credentialSaveRequestSchema,
} from "@neurochess/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { setupFieldClass } from "../arena/setup/ModelPicker";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";

import { useCredentials } from "./context";

export function CredentialSettings() {
  const library = useCredentials();
  const { t } = useTranslation();
  const id = useId();
  const [confirmation, setConfirmation] = useState<CredentialMetadata | "all" | null>(null);
  if (!library) return null;
  const { state, controller } = library;
  return (
    <section
      id="credentials"
      aria-labelledby={`${id}-title`}
      className="grid min-w-0 gap-5 border-t border-divider pt-5"
    >
      <h2 id={`${id}-title`} className="text-section font-semibold">
        {t("credentials.title")}
      </h2>
      <p className="text-body text-text-secondary">{t("credentials.persistence")}</p>
      <SaveCredentialForm />
      {state.issue ? (
        <p role="alert" className="text-body text-danger">
          {t(`credentials.errors.${state.issue}`)}
        </p>
      ) : null}
      {state.result ? <p role="status">{t(`credentials.results.${state.result}`)}</p> : null}
      {state.loading ? <p role="status">{t("credentials.loading")}</p> : null}
      {!state.credentials.length && !state.loading && !state.issue ? (
        <p>{t("credentials.empty")}</p>
      ) : null}
      <ul className="grid min-w-0 gap-3">
        {state.credentials.map((record) => (
          <li
            key={record.credentialId}
            className="grid min-w-0 gap-2 rounded-control border border-divider p-3 text-body"
          >
            <span className="font-semibold wrap-anywhere">{record.label}</span>
            <span>
              {t(`setup.providers.${record.provider}`)} ·{" "}
              {record.maskedSuffix ? `••••${record.maskedSuffix}` : t("credentials.masked")}
            </span>
            <time className="text-label text-text-secondary" dateTime={record.createdAt}>
              {t("credentials.created", {
                date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                  new Date(record.createdAt),
                ),
              })}
            </time>
            <Button
              variant="quiet"
              aria-disabled={state.busy}
              aria-label={t("credentials.revokeLabel", { label: record.label })}
              onClick={() => setConfirmation(record)}
            >
              {t("credentials.revoke")}
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          aria-disabled={state.loading || state.busy}
          onClick={() => void controller.refresh()}
        >
          {t("credentials.refresh")}
        </Button>
        {state.nextCursor ? (
          <Button
            variant="secondary"
            aria-disabled={state.loading || state.busy}
            onClick={() => void controller.more()}
          >
            {t("credentials.more")}
          </Button>
        ) : null}
        <Button
          variant="quiet"
          aria-disabled={state.busy || (!state.credentials.length && !state.nextCursor)}
          onClick={() => setConfirmation("all")}
        >
          {t("credentials.clear")}
        </Button>
      </div>
      {confirmation ? (
        <Dialog
          title={t(confirmation === "all" ? "credentials.clear" : "credentials.revoke")}
          description={t(
            confirmation === "all"
              ? "credentials.clearDescription"
              : "credentials.revokeDescription",
            { label: confirmation === "all" ? "" : confirmation.label },
          )}
          onCancel={() => {
            if (!state.busy) setConfirmation(null);
          }}
        >
          <div className="mt-5 flex flex-wrap gap-3">
            <Button
              variant="secondary"
              aria-disabled={state.busy}
              onClick={() => setConfirmation(null)}
            >
              {t("credentials.cancel")}
            </Button>
            <Button
              variant="danger"
              aria-disabled={state.busy}
              onClick={() => {
                const operation =
                  confirmation === "all"
                    ? controller.clear()
                    : controller.revoke(confirmation.credentialId);
                void operation.then(() => setConfirmation(null));
              }}
            >
              {t(confirmation === "all" ? "credentials.clear" : "credentials.revoke")}
            </Button>
          </div>
          {state.busy ? (
            <p role="status" className="mt-3">
              {t("credentials.pending")}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </section>
  );
}

function SaveCredentialForm() {
  const library = useCredentials();
  const { t } = useTranslation();
  const id = useId();
  const key = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<AiProvider>("openai");
  const [label, setLabel] = useState("");
  const [save, setSave] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [hasValue, setHasValue] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const clear = () => {
      if (key.current) key.current.value = "";
      setSave(false);
      setRevealed(false);
      setHasValue(false);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  if (!library) return null;
  const { state, controller } = library;
  const disabled = state.busy || state.uncertain;
  return (
    <form
      noValidate
      className="grid min-w-0 gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const input = credentialSaveRequestSchema.safeParse({
          save,
          provider,
          label,
          apiKey: key.current?.value ?? "",
        });
        setInvalid(!input.success);
        if (!input.success) return;
        if (key.current) key.current.value = "";
        setSave(false);
        setRevealed(false);
        setHasValue(false);
        void controller.save(input.data);
      }}
    >
      <label htmlFor={`${id}-provider`} className="text-label">
        {t("setup.provider")}
      </label>
      <Select
        id={`${id}-provider`}
        value={provider}
        aria-disabled={disabled}
        onChange={(event) => {
          const result = aiProviderSchema.safeParse(event.target.value);
          if (!disabled && result.success) setProvider(result.data);
        }}
      >
        {aiProviderSchema.options.map((value) => (
          <option key={value} value={value}>
            {t(`setup.providers.${value}`)}
          </option>
        ))}
      </Select>
      <label htmlFor={`${id}-label`} className="text-label">
        {t("credentials.label")}
      </label>
      <input
        id={`${id}-label`}
        className={setupFieldClass}
        value={label}
        maxLength={64}
        readOnly={disabled}
        onChange={(event) => setLabel(event.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <label htmlFor={`${id}-key`} className="text-label">
        {t("setup.apiKey")}
      </label>
      <div className="flex min-w-0 flex-wrap gap-2">
        <input
          ref={key}
          id={`${id}-key`}
          className={`${setupFieldClass} flex-[1_1_10rem]`}
          type={revealed ? "text" : "password"}
          maxLength={4096}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            setHasValue(Boolean(event.target.value));
            if (!event.target.value) setRevealed(false);
          }}
        />
        <Button
          variant="secondary"
          aria-controls={`${id}-key`}
          aria-pressed={revealed}
          aria-disabled={disabled || !hasValue}
          onClick={() => setRevealed(!revealed)}
        >
          {t(revealed ? "setup.hideKey" : "setup.showKey")}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-label text-text-secondary">
        {t("credentials.saveHint")}
      </p>
      <label className="flex min-h-target items-center gap-3 text-body">
        <input
          type="checkbox"
          checked={save}
          aria-disabled={disabled}
          onChange={(event) => {
            if (!disabled) setSave(event.target.checked);
          }}
        />
        {t("credentials.optIn")}
      </label>
      {invalid ? (
        <p role="alert" className="text-danger">
          {t("credentials.invalid")}
        </p>
      ) : null}
      <Button variant="primary" type="submit" aria-disabled={disabled || !save}>
        {t("credentials.save")}
      </Button>
    </form>
  );
}
