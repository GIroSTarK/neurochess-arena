import type { CredentialMetadata } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { AiIdentity } from "../api/ai-client";
import { credentialError, type CredentialFailure } from "../api/credential-client";
import { AccountFrame } from "../auth/AccountFrame";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import { SaveCredentialForm } from "./SaveCredentialForm";
import { useCredentials } from "./use-credentials";

export function CredentialsScreen({
  apiBaseUrl,
  identity,
  sandboxEnabled,
  returnTo,
}: {
  readonly apiBaseUrl: string;
  readonly identity: AiIdentity;
  readonly sandboxEnabled: boolean;
  readonly returnTo: string;
}) {
  const { t, i18n } = useTranslation();
  const { catalog, state } = useCredentials(apiBaseUrl, identity);
  const [confirmation, setConfirmation] = useState<CredentialMetadata | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CredentialFailure["code"] | null>(null);
  const pending = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const clear = () => {
      operation.current?.abort();
      pending.current = false;
      setBusy(false);
      setConfirmation(null);
      setError(null);
    };
    window.addEventListener("pagehide", clear);
    return () => {
      operation.current?.abort();
      window.removeEventListener("pagehide", clear);
    };
  }, []);
  async function remove() {
    if (!confirmation || pending.current || !catalog.api) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const abort = new AbortController();
    operation.current = abort;
    try {
      if (confirmation === "all") await catalog.api.clear(abort.signal);
      else await catalog.api.revoke(confirmation.credentialId, abort.signal);
      if (abort.signal.aborted || catalog.api.signal.aborted) return;
      setConfirmation(null);
      listHeading.current?.focus();
      await catalog.changed();
    } catch (error) {
      if (!abort.signal.aborted && credentialError(error) !== "cancelled") {
        setError(credentialError(error));
      }
    } finally {
      if (!abort.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <AccountFrame title={t("credentials.title")} sandboxEnabled={sandboxEnabled}>
      <p className="text-body text-text-secondary">{t("credentials.description")}</p>
      <SaveCredentialForm catalog={catalog} />
      <section className="grid min-w-0 gap-4 border-t border-divider pt-6">
        <h2 ref={listHeading} tabIndex={-1} className="text-section font-semibold">
          {t("credentials.list")}
        </h2>
        {state.phase === "loading" ? <p role="status">{t("account.loading")}</p> : null}
        {state.phase === "error" ? <p role="alert">{t("credentials.loadError")}</p> : null}
        {state.phase === "ready" && state.credentials.length === 0 ? (
          <p>{t("credentials.empty")}</p>
        ) : null}
        <ul className="grid min-w-0 gap-3">
          {state.credentials.map((item) => (
            <li
              key={item.credentialId}
              className="grid min-w-0 grid-cols-1 gap-2 rounded-control border border-divider p-3"
            >
              <p className="font-semibold break-words">{item.label}</p>
              <p className="text-label text-text-secondary">
                {t(`setup.providers.${item.provider}`)} ·{" "}
                {item.maskedSuffix
                  ? t("credentials.suffix", { suffix: item.maskedSuffix })
                  : t("credentials.masked")}
              </p>
              <p className="text-label text-text-secondary">
                {t("credentials.created", {
                  date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
                    new Date(item.createdAt),
                  ),
                })}
              </p>
              <Button
                variant="secondary"
                aria-label={t("credentials.revokeLabel", { label: item.label })}
                aria-disabled={busy}
                onClick={() => {
                  setError(null);
                  setConfirmation(item);
                }}
              >
                {t("credentials.revoke")}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => void catalog.refresh()}>
            {t("credentials.refresh")}
          </Button>
          <Button
            variant="secondary"
            aria-disabled={busy || state.credentials.length === 0}
            onClick={() => {
              setError(null);
              setConfirmation("all");
            }}
          >
            {t("credentials.clear")}
          </Button>
        </div>
      </section>
      <Link to={returnTo} className="inline-flex min-h-target items-center text-accent underline">
        {t("account.return")}
      </Link>
      {confirmation ? (
        <Dialog
          title={t(confirmation === "all" ? "credentials.clearTitle" : "credentials.revokeTitle")}
          description={t("credentials.revokeHint")}
          onCancel={() => {
            if (!pending.current) setConfirmation(null);
          }}
        >
          {confirmation !== "all" ? <p className="mt-3 break-words">{confirmation.label}</p> : null}
          {error ? (
            <p role="alert" className="mt-3 text-danger">
              {t(`credentials.errors.${error}`)}
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button variant="secondary" aria-disabled={busy} onClick={() => setConfirmation(null)}>
              {t("actions.cancel")}
            </Button>
            <Button variant="danger" aria-disabled={busy} onClick={() => void remove()}>
              {t(
                busy
                  ? "account.working"
                  : confirmation === "all"
                    ? "credentials.clear"
                    : "credentials.revoke",
              )}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </AccountFrame>
  );
}
