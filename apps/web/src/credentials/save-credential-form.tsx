import { aiProviderSchema, credentialSaveRequestSchema } from "@neurochess/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";

import type { CredentialFailure } from "../api/credential-client";
import type { AiIdentity } from "../api/identity";
import { AccountField } from "../auth/account-field";
import { PasswordField } from "../auth/password-field";
import { Button } from "../ui/button";
import { Select } from "../ui/select";

import type { CredentialCatalogState } from "./catalog";
import type { CredentialActionData } from "./route-data";

export function SaveCredentialForm({
  identity,
  catalog,
  version,
  refresh,
}: {
  readonly identity: AiIdentity;
  readonly catalog: CredentialCatalogState;
  readonly version: number;
  readonly refresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const providerId = useId();
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const mutation = useFetcher<CredentialActionData | null>();
  const reset = mutation.reset;
  const busy = mutation.state !== "idle";
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<CredentialFailure["code"] | null>(null);
  const [saved, setSaved] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  // An absent record cannot rule out a late commit. Explicit retries keep the ID
  // until a response or a fresh metadata read proves the earlier save was stored.
  const [unconfirmed, setUnconfirmed] = useState<{
    id: string;
    after: number;
    reconciled: boolean;
  } | null>(null);
  const reconciling = unconfirmed !== null && !unconfirmed.reconciled;
  const outcome = mutation.data?.data;
  if (!busy && submittedId && settled) {
    setSubmittedId(null);
    if (outcome && "success" in outcome) {
      setSaved(true);
      setUnconfirmed(null);
    } else {
      // A canceled route action returns no outcome even when the API may have committed.
      const error = outcome?.error ?? "CREDENTIAL_UNAVAILABLE";
      setError(error);
      if (error === "CREDENTIAL_UNAVAILABLE" || error === "CREDENTIAL_CONFLICT") {
        setUnconfirmed({ id: submittedId, after: version, reconciled: false });
      }
    }
  }
  useEffect(() => {
    if (settled && !submittedId) void refresh();
  }, [settled, submittedId, refresh]);
  if (
    !busy &&
    !submittedId &&
    unconfirmed &&
    catalog.phase === "ready" &&
    version > unconfirmed.after
  ) {
    if (catalog.credentials.some((item) => item.credentialId === unconfirmed.id)) {
      setUnconfirmed(null);
      if (error !== "CREDENTIAL_CONFLICT") {
        setSaved(true);
        setError(null);
      }
    } else if (!unconfirmed.reconciled) {
      setUnconfirmed({ ...unconfirmed, reconciled: true });
    }
  }
  useEffect(() => {
    const element = form.current;
    const clear = () => {
      element?.reset();
      reset();
      pending.current = false;
      setConsent(false);
      setError(null);
      setSaved(false);
      setSubmittedId(null);
      setUnconfirmed(null);
      setSettled(false);
    };
    window.addEventListener("pagehide", clear);
    identity.signal.addEventListener("abort", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      identity.signal.removeEventListener("abort", clear);
      // An unmount has already detached the form, so scrub the key it may still hold.
      // StrictMode's dev replay keeps it connected; resetting then would erase entered input.
      if (!element?.isConnected) element?.reset();
      reset();
    };
  }, [identity.signal, reset]);
  function save() {
    if (
      !form.current ||
      busy ||
      pending.current ||
      !consent ||
      reconciling ||
      identity.signal.aborted ||
      !identity.expectedAccount
    ) {
      return;
    }
    const data = new FormData(form.current);
    const id = unconfirmed?.id ?? crypto.randomUUID();
    const input = credentialSaveRequestSchema.safeParse({
      credentialId: id,
      provider: data.get("provider"),
      label: data.get("label"),
      apiKey: data.get("apiKey"),
      save: true,
    });
    if (!input.success) {
      setError("CREDENTIAL_INVALID_REQUEST");
      setSaved(false);
      return;
    }
    data.set("intent", "save");
    data.set("save", "true");
    data.set("credentialId", id);
    data.set("expectedAccount", identity.expectedAccount);
    form.current.reset();
    setConsent(false);
    setError(null);
    setSaved(false);
    setSubmittedId(id);
    setSettled(false);
    pending.current = true;
    reset();
    void mutation.submit(data, { method: "post", action: "/account/credentials" }).finally(() => {
      pending.current = false;
      if (!identity.signal.aborted) setSettled(true);
    });
  }
  return (
    <mutation.Form
      method="post"
      action="/account/credentials"
      ref={form}
      className="grid min-w-0 gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
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
      <Button type="submit" variant="primary" aria-disabled={busy || !consent || reconciling}>
        {t(busy ? "account.working" : "credentials.save")}
      </Button>
    </mutation.Form>
  );
}
