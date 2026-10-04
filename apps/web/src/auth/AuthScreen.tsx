import {
  authEmailRequestSchema,
  type AuthOAuthProvider,
  authPasswordSchema,
  authSignInRequestSchema,
} from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { accountError, type AccountErrorCode, AccountFailure } from "../api/auth-client";
import type { AuthForm } from "../app/route-urls";
import { Button } from "../ui/Button";

import { AccountField } from "./AccountField";
import { AccountFrame } from "./AccountFrame";
import { useRequiredAccount } from "./context";
import { type AuthEntry, authHref } from "./navigation";
import { PasswordField } from "./PasswordField";

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
  const title = forms[kind];
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountErrorCode | null>(entry.error);
  const [notice, setNotice] = useState<"accepted" | "resetDone" | null>(null);
  const [invalid, setInvalid] = useState<"email" | "password" | null>(null);
  useEffect(() => {
    let abort = new AbortController();
    lifetime.current = abort;
    const clear = () => {
      abort.abort();
      entry.clearResetToken();
      form.current?.reset();
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
    return () => {
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", restore);
      abort.abort();
    };
  }, [entry]);

  async function perform(provider?: AuthOAuthProvider) {
    const signal = lifetime.current?.signal;
    const isCancelled = () => !signal || signal.aborted;
    if (!signal || isCancelled() || pending.current || !form.current) return;
    const data = new FormData(form.current);
    const emailValue = data.get("email");
    const email = typeof emailValue === "string" ? emailValue.trim() : "";
    const passwordValue = data.get("password");
    const password = typeof passwordValue === "string" ? passwordValue : "";
    if (!provider) {
      if (kind !== "reset-password" && !authEmailRequestSchema.safeParse({ email }).success) {
        setInvalid("email");
        return;
      }
      if (
        ((kind === "sign-up" || kind === "reset-password") &&
          !authPasswordSchema.safeParse(password).success) ||
        (kind === "sign-in" && !authSignInRequestSchema.safeParse({ email, password }).success)
      ) {
        setInvalid("password");
        return;
      }
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setInvalid(null);
    const passwordField = form.current.elements.namedItem("password");
    if (passwordField instanceof HTMLInputElement) {
      passwordField.value = "";
      passwordField.dispatchEvent(new Event("input", { bubbles: true }));
    }
    try {
      const api = account.controller.api;
      if (provider) {
        const url = await account.controller.transition((signal) => api.social(provider, signal));
        if (!isCancelled()) window.location.assign(url);
      } else if (kind === "sign-in") {
        await account.controller.transition((signal) => api.signIn({ email, password }, signal));
        if (!isCancelled()) window.location.assign(entry.returnTo);
      } else if (kind === "reset-password") {
        const token = entry.readResetToken();
        if (!token) throw new AccountFailure("AUTH_INVALID_TOKEN");
        await account.controller.transition((signal) => api.reset(token, password, signal));
        entry.clearResetToken();
        if (!isCancelled()) setNotice("resetDone");
      } else {
        if (kind === "sign-up") await api.register({ email, password }, signal);
        else if (kind === "verify") await api.resend(email, signal);
        else await api.forgot(email, signal);
        if (!isCancelled()) setNotice("accepted");
      }
    } catch (error) {
      if (!isCancelled() && accountError(error) !== "cancelled") setError(accountError(error));
    } finally {
      pending.current = false;
      if (!isCancelled()) setBusy(false);
    }
  }
  const hasPassword = kind === "sign-in" || kind === "sign-up" || kind === "reset-password";
  const invalidReset =
    kind === "reset-password" && !entry.readResetToken() && notice !== "resetDone";
  return (
    <AccountFrame title={t(`account.titles.${title}`)} sandboxEnabled={sandboxEnabled}>
      <p className="text-body text-text-secondary">{t("account.separation")}</p>
      {entry.verified ? <p role="status">{t("account.verified")}</p> : null}
      <form
        ref={form}
        noValidate
        className="grid min-w-0 gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void perform();
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
                onClick={() => void perform(provider)}
              >
                {t(`account.${provider}`)}
              </Button>
            ))}
          </div>
        ) : null}
      </form>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-label">
        {kind !== "sign-in" ? (
          <a
            className="inline-flex min-h-target items-center text-accent underline"
            href={authHref("sign-in", entry.returnTo)}
          >
            {t("account.signIn")}
          </a>
        ) : null}
        {kind === "sign-in" ? (
          <a
            className="inline-flex min-h-target items-center text-accent underline"
            href={authHref("sign-up", entry.returnTo)}
          >
            {t("account.titles.signUp")}
          </a>
        ) : null}
        <a
          className="inline-flex min-h-target items-center text-accent underline"
          href={authHref("verify", entry.returnTo)}
        >
          {t("account.resend")}
        </a>
        <a
          className="inline-flex min-h-target items-center text-accent underline"
          href={authHref("forgot-password", entry.returnTo)}
        >
          {t("account.titles.forgot")}
        </a>
        <a
          className="inline-flex min-h-target items-center text-accent underline"
          href={entry.returnTo}
        >
          {t("account.return")}
        </a>
      </div>
    </AccountFrame>
  );
}
