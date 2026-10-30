import type { CredentialMetadata } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher, useLoaderData } from "react-router";

import type { PublicIdentity } from "../api/identity";
import { AccountFrame } from "../auth/account-frame";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { TextLink } from "../ui/text-link";

import type { CredentialActionData, CredentialRouteData } from "./route-data";
import { SaveCredentialForm } from "./save-credential-form";
import { useCredentials } from "./use-credentials";

export function CredentialsScreen({
  identity,
  returnTo,
}: {
  readonly identity: PublicIdentity;
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
    <AccountFrame
      title={t("credentials.title")}
      width="wide"
      description={t("credentials.description")}
      actions={<TextLink to={returnTo}>{t("account.return")}</TextLink>}
    >
      <div className="grid min-w-0 items-start gap-8 @min-[56rem]/page:grid-cols-[minmax(0,1fr)_24rem]">
        <section className="grid min-w-0 gap-4" aria-label={t("credentials.list")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 ref={listHeading} tabIndex={-1} className="text-section font-semibold">
              {t("credentials.list")}
            </h2>
            <Button variant="quiet" onClick={() => void refresh()}>
              {t("credentials.refresh")}
            </Button>
          </div>
          {state.phase === "loading" ? <p role="status">{t("account.loading")}</p> : null}
          {state.phase === "error" ? <p role="alert">{t("credentials.loadError")}</p> : null}
          {state.phase === "ready" && state.credentials.length === 0 ? (
            <p className="border-y border-divider py-6 text-text-secondary">
              {t("credentials.empty")}
            </p>
          ) : null}
          <ul className="grid min-w-0 divide-y divide-divider">
            {state.credentials.map((item) => (
              <li
                key={item.credentialId}
                className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 py-4"
              >
                <div className="grid min-w-0 flex-[1_1_16rem] gap-2">
                  <p className="font-semibold wrap-anywhere">{item.label}</p>
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
                </div>
                <Button
                  variant="quiet-danger"
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
          <div className="flex flex-wrap justify-end border-t border-divider pt-4">
            <Button
              variant="quiet-danger"
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
        <SaveCredentialForm
          identity={identity}
          catalog={state}
          version={version}
          refresh={refresh}
        />
      </div>
      {confirmation ? (
        <ConfirmDialog
          title={t(confirmation === "all" ? "credentials.clearTitle" : "credentials.revokeTitle")}
          description={t("credentials.revokeHint")}
          cancelLabel={t("actions.cancel")}
          confirmLabel={t(
            busy
              ? "account.working"
              : confirmation === "all"
                ? "credentials.clear"
                : "credentials.revoke",
          )}
          cancelDisabled={busy}
          confirmDisabled={busy}
          onConfirm={remove}
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
        </ConfirmDialog>
      ) : null}
    </AccountFrame>
  );
}
