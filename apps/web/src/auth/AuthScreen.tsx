import type { AuthOAuthProvider } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useFetcher } from "react-router";

import type { AuthForm } from "../app/route-urls";
import { Button } from "../ui/Button";

import { AccountField } from "./AccountField";
import { AccountFrame } from "./AccountFrame";
import { useRequiredAccount } from "./context";
import { authFormInvalid } from "./form-validation";
import { type AuthEntry, authHref } from "./navigation";
import { PasswordField } from "./PasswordField";
import type { AuthActionData } from "./route-data";

const forms: Record<AuthForm, "signIn" | "signUp" | "verify" | "forgot" | "reset"> = {
  "sign-in": "signIn",
  "sign-up": "signUp",
  verify: "verify",
  "forgot-password": "forgot",
  "reset-password": "reset",
};

export function AuthScreen({
  entry,
  sandboxEnabled,
  kind,
}: {
  readonly entry: AuthEntry;
  readonly sandboxEnabled: boolean;
  readonly kind: AuthForm;
}) {
  const { t } = useTranslation();
  const account = useRequiredAccount();
  const fetcher = useFetcher<AuthActionData>();
  const resetFetcher = fetcher.reset;
  const title = forms[kind];
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const [localInvalid, setLocalInvalid] = useState<"email" | "password" | null>(null);
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data?.generation === account.state.revision ? fetcher.data.data : null;
  const error = outcome && "error" in outcome ? outcome.error : entry.error;
  const notice =
    outcome &&
    "notice" in outcome &&
    (outcome.notice === "accepted" || outcome.notice === "resetDone")
      ? outcome.notice
      : null;
  const invalid = localInvalid ?? (outcome && "invalid" in outcome ? outcome.invalid : null);
  const action = `/auth/${kind}${entry.returnTo === "/" ? "" : "?returnTo=" + encodeURIComponent(entry.returnTo)}`;
  useEffect(() => {
    if (!busy) pending.current = false;
  }, [busy]);
  useEffect(() => {
    const controller = account.controller;
    let revision = controller.getSnapshot().revision;
    // Read the transition owner at invalidation time; it may have settled by
    // the next React effect, even when this form initiated the change.
    return controller.subscribe(() => {
      const next = controller.getSnapshot().revision;
      if (next === revision) return;
      revision = next;
      if (pending.current && controller.transitionPending) return;
      form.current?.reset();
      resetFetcher();
      setLocalInvalid(null);
      pending.current = false;
    });
  }, [account.controller, resetFetcher]);
  useEffect(() => {
    const element = form.current;
    const clear = () => {
      entry.clearResetToken();
      element?.reset();
      resetFetcher();
      setLocalInvalid(null);
      pending.current = false;
    };
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      element?.reset();
    };
  }, [entry, resetFetcher]);

  function perform(provider?: AuthOAuthProvider) {
    if (pending.current || busy || !form.current) return;
    const data = provider ? new FormData() : new FormData(form.current);
    if (!provider) {
      const email = data.get("email");
      const password = data.get("password");
      const invalid = authFormInvalid(
        kind,
        typeof email === "string" ? email.trim() : "",
        typeof password === "string" ? password : "",
      );
      setLocalInvalid(invalid);
      if (invalid) return;
    } else {
      setLocalInvalid(null);
    }
    data.set("intent", provider ? "oauth" : kind);
    if (provider) data.set("provider", provider);
    const passwordField = form.current.elements.namedItem("password");
    if (passwordField instanceof HTMLInputElement) {
      passwordField.value = "";
      passwordField.dispatchEvent(new Event("input", { bubbles: true }));
    }
    pending.current = true;
    void fetcher.submit(data, { method: "post", action });
  }
  const hasPassword = kind === "sign-in" || kind === "sign-up" || kind === "reset-password";
  const invalidReset = kind === "reset-password" && !entry.hasResetToken && notice !== "resetDone";
  return (
    <AccountFrame title={t(`account.titles.${title}`)} sandboxEnabled={sandboxEnabled}>
      <p className="text-body text-text-secondary">{t("account.separation")}</p>
      {entry.verified ? <p role="status">{t("account.verified")}</p> : null}
      <fetcher.Form
        ref={form}
        method="post"
        action={action}
        noValidate
        className="grid min-w-0 gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          perform();
        }}
      >
        {kind !== "reset-password" ? (
          <AccountField
            name="email"
            type="email"
            label={t("account.email")}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            readOnly={busy}
            error={invalid === "email" ? t("account.emailInvalid") : null}
          />
        ) : null}
        {hasPassword && !invalidReset && notice !== "resetDone" ? (
          <PasswordField
            name="password"
            showLabel={t("account.showPassword")}
            hideLabel={t("account.hidePassword")}
            label={t("account.password")}
            autoComplete={kind === "sign-in" ? "current-password" : "new-password"}
            maxLength={128}
            readOnly={busy}
            hint={t("account.passwordHint")}
            error={invalid === "password" ? t("account.passwordInvalid") : null}
          />
        ) : null}
        {invalidReset || error ? (
          <p role="alert" className="text-body text-danger">
            {t(
              `account.errors.${invalidReset ? "AUTH_INVALID_TOKEN" : (error ?? "AUTH_UNAVAILABLE")}`,
            )}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-body">
            {t(`account.${notice}`)}
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="text-label text-text-secondary">
            {t("account.working")}
          </p>
        ) : null}
        {!invalidReset && notice !== "resetDone" ? (
          <Button type="submit" variant="primary" aria-disabled={busy}>
            {t(`account.actions.${title}`)}
          </Button>
        ) : null}
        {kind === "sign-in" || kind === "sign-up" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {(["google", "github"] as const).map((provider) => (
              <Button
                key={provider}
                variant="secondary"
                aria-disabled={busy}
                onClick={() => perform(provider)}
              >
                {t(`account.${provider}`)}
              </Button>
            ))}
          </div>
        ) : null}
      </fetcher.Form>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-label">
        {kind !== "sign-in" ? (
          <Link
            className="inline-flex min-h-target items-center text-accent underline"
            to={authHref("sign-in", entry.returnTo)}
          >
            {t("account.signIn")}
          </Link>
        ) : null}
        {kind === "sign-in" ? (
          <Link
            className="inline-flex min-h-target items-center text-accent underline"
            to={authHref("sign-up", entry.returnTo)}
          >
            {t("account.titles.signUp")}
          </Link>
        ) : null}
        <Link
          className="inline-flex min-h-target items-center text-accent underline"
          to={authHref("verify", entry.returnTo)}
        >
          {t("account.resend")}
        </Link>
        <Link
          className="inline-flex min-h-target items-center text-accent underline"
          to={authHref("forgot-password", entry.returnTo)}
        >
          {t("account.titles.forgot")}
        </Link>
        <Link
          className="inline-flex min-h-target items-center text-accent underline"
          to={entry.returnTo}
        >
          {t("account.return")}
        </Link>
      </div>
    </AccountFrame>
  );
}
