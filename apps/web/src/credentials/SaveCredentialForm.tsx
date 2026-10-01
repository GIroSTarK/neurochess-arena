import { aiProviderSchema, credentialSaveRequestSchema } from "@neurochess/contracts";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { credentialError, type CredentialFailure } from "../api/credential-client";
import { AccountField } from "../auth/AccountField";
import { PasswordField } from "../auth/PasswordField";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";

import type { CredentialCatalog } from "./catalog";

export function SaveCredentialForm({ catalog }: { readonly catalog: CredentialCatalog }) {
  const { t } = useTranslation();
  const providerId = useId();
  const form = useRef<HTMLFormElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<CredentialFailure["code"] | null>(null);
  const [saved, setSaved] = useState(false);
  const [unconfirmedId, setUnconfirmedId] = useState<string | null>(null);
  const catalogState = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  if (unconfirmedId && catalogState.phase === "ready") {
    setUnconfirmedId(null);
    if (catalogState.credentials.some((item) => item.credentialId === unconfirmedId)) {
      setSaved(true);
      setError(null);
    }
  }
  useEffect(() => {
    let abort = new AbortController();
    lifetime.current = abort;
    const clear = () => {
      abort.abort();
      form.current?.reset();
      setConsent(false);
      setError(null);
      setSaved(false);
      setUnconfirmedId(null);
    };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      abort = new AbortController();
      lifetime.current = abort;
      pending.current = false;
      setBusy(false);
    };
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", restore);
    catalog.api?.signal.addEventListener("abort", clear);
    return () => {
      abort.abort();
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", restore);
      catalog.api?.signal.removeEventListener("abort", clear);
    };
  }, [catalog]);
  async function save() {
    const signal = lifetime.current?.signal;
    if (
      !form.current ||
      !signal ||
      signal.aborted ||
      !catalog.api ||
      pending.current ||
      !consent ||
      unconfirmedId !== null
    ) {
      return;
    }
    const isCancelled = () => signal.aborted || catalog.api?.signal.aborted;
    const data = new FormData(form.current);
    const input = credentialSaveRequestSchema.safeParse({
      credentialId: crypto.randomUUID(),
      save: true,
      provider: data.get("provider"),
      label: data.get("label"),
      apiKey: data.get("apiKey"),
    });
    if (!input.success) {
      setError("CREDENTIAL_INVALID_REQUEST");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    form.current.reset();
    setConsent(false);
    try {
      await catalog.api.save(input.data, signal);
      if (isCancelled()) return;
      setSaved(true);
      await catalog.changed();
    } catch (error) {
      if (!isCancelled() && credentialError(error) !== "cancelled") {
        setError(credentialError(error));
        // A lost save acknowledgement may already have inserted the record.
        await catalog.changed();
        if (!isCancelled()) setUnconfirmedId(input.data.credentialId);
      }
    } finally {
      if (!isCancelled()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <form
      ref={form}
      className="grid min-w-0 gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="text-section font-semibold">{t("credentials.add")}</h2>
      <div className="grid gap-2 text-label">
        <label htmlFor={providerId}>{t("setup.provider")}</label>
        <Select id={providerId} name="provider" defaultValue="openai" disabled={busy}>
          {aiProviderSchema.options.map((provider) => (
            <option key={provider} value={provider}>
              {t(`setup.providers.${provider}`)}
            </option>
          ))}
        </Select>
      </div>
      <AccountField
        name="label"
        label={t("credentials.label")}
        maxLength={64}
        readOnly={busy}
        autoComplete="off"
        hint={t("credentials.labelHint")}
      />
      <PasswordField
        name="apiKey"
        label={t("setup.apiKey")}
        maxLength={4096}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        readOnly={busy}
        showLabel={t("setup.showKey")}
        hideLabel={t("setup.hideKey")}
      />
      <p className="text-body text-text-secondary">{t("credentials.persistence")}</p>
      <label className="flex min-h-target items-center gap-3 text-label">
        <input
          type="checkbox"
          className="size-5 shrink-0 accent-accent"
          checked={consent}
          disabled={busy}
          onChange={(event) => setConsent(event.currentTarget.checked)}
        />
        {t("credentials.saveOptIn")}
      </label>
      {error ? (
        <p role="alert" className="text-danger">
          {t(`credentials.errors.${error}`)}
        </p>
      ) : null}
      {saved ? <p role="status">{t("credentials.saved")}</p> : null}
      <Button
        type="submit"
        variant="primary"
        aria-disabled={busy || !consent || unconfirmedId !== null}
      >
        {t(busy ? "account.working" : "credentials.save")}
      </Button>
    </form>
  );
}
