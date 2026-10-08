import type { CredentialMetadata } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useFetcher, useLoaderData } from "react-router";

import type { AiIdentity } from "../api/identity";
import { AccountFrame } from "../auth/AccountFrame";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import type { CredentialActionData, CredentialRouteData } from "./route-data";
import { SaveCredentialForm } from "./SaveCredentialForm";
import { useCredentials } from "./use-credentials";

export function CredentialsScreen({
  identity,
  sandboxEnabled,
  returnTo,
}: {
  readonly identity: AiIdentity;
  readonly sandboxEnabled: boolean;
  readonly returnTo: string;
}) {
  const { t, i18n } = useTranslation();
  const loader = useLoaderData<CredentialRouteData | null>();
  const { state, refresh, version } = useCredentials(identity, true, undefined, loader);
  const mutation = useFetcher<CredentialActionData | null>();
  const reset = mutation.reset;
  const [confirmation, setConfirmation] = useState<CredentialMetadata | "all" | null>(null);
  const busy = mutation.state !== "idle";
  const outcome = mutation.data?.data;
  const error = outcome && "error" in outcome ? outcome.error : null;
  const [acknowledged, setAcknowledged] = useState<CredentialActionData | null>(null);
  const pending = useRef(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const clear = () => {
      reset();
      pending.current = false;
      setConfirmation(null);
    };
    window.addEventListener("pagehide", clear);
    return () => {
      reset();
      window.removeEventListener("pagehide", clear);
    };
  }, [reset]);
  if (outcome && "success" in outcome && mutation.data !== acknowledged) {
    setAcknowledged(mutation.data ?? null);
    setConfirmation(null);
  }
  useEffect(() => {
    if (acknowledged) {
      listHeading.current?.focus();
      void refresh();
    }
  }, [acknowledged, refresh]);
  function remove() {
    if (!confirmation || busy || pending.current || !identity.expectedAccount) return;
    pending.current = true;
    reset();
    void mutation
      .submit(
        {
          ...(confirmation === "all"
            ? { intent: "clear" }
            : { intent: "revoke", credentialId: confirmation.credentialId }),
          confirm: "true",
          expectedAccount: identity.expectedAccount,
        },
        { method: "post", action: "/account/credentials" },
      )
      .finally(() => {
        pending.current = false;
      });
  }
  return (
    <AccountFrame title={t("credentials.title")} sandboxEnabled={sandboxEnabled}>
      <p className="text-body text-text-secondary">{t("credentials.description")}</p>
      <SaveCredentialForm identity={identity} catalog={state} version={version} refresh={refresh} />
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
                  reset();
                  setConfirmation(item);
                }}
              >
                {t("credentials.revoke")}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => void refresh()}>
            {t("credentials.refresh")}
          </Button>
          <Button
            variant="secondary"
            aria-disabled={busy || state.credentials.length === 0}
            onClick={() => {
              reset();
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
            <Button variant="danger" aria-disabled={busy} onClick={remove}>
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
