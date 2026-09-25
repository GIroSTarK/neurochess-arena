import { authEmailSchema, type AuthOAuthProvider, authPasswordSchema } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";

import { AccountLayout } from "./AccountLayout";
import { AccountFailure } from "./client";
import { useRequiredAccount } from "./context";
import { Field } from "./Field";
import { type AuthEntry, authHref, type AuthPage, navigateAccount, safeReturn } from "./navigation";

export function AuthScreen({
  page,
  entry,
  sandboxEnabled,
}: {
  readonly page: AuthPage;
  readonly entry: AuthEntry;
  readonly sandboxEnabled: boolean;
}) {
  const { t } = useTranslation();
  const account = useRequiredAccount();
  const { controller } = account;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(entry.token);
  const [pending, setPending] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const [methods, setMethods] = useState<Awaited<ReturnType<typeof controller.api.methods>> | null>(
    null,
  );
  const [methodError, setMethodError] = useState(false);
  const [reload, setReload] = useState(0);
  const [failure, setFailure] = useState<AccountFailure | null>(
    entry.error ? new AccountFailure(entry.error) : null,
  );
  const [invalid, setInvalid] = useState(false);
  const [complete, setComplete] = useState(false);
  const destination = safeReturn(new URLSearchParams(window.location.search).get("returnTo"));
  const link = (target: AuthPage) => authHref(target, destination);
  useEffect(() => {
    const request = new AbortController();
    void controller.api.methods(request.signal).then(
      (result) => {
        if (!request.signal.aborted) {
          setMethods(result);
          setMethodError(false);
        }
      },
      () => {
        if (!request.signal.aborted) setMethodError(true);
      },
    );
    const hide = () => {
      operation.current?.abort();
      setToken(undefined);
      setPassword("");
    };
    window.addEventListener("pagehide", hide);
    return () => {
      request.abort();
      operation.current?.abort();
      window.removeEventListener("pagehide", hide);
    };
  }, [controller, reload]);
  useEffect(() => {
    if (page === "complete" && entry.result) void controller.changed();
  }, [controller, page, entry.result]);
  const usesEmail = ["sign-in", "sign-up", "resend", "forgot-password"].includes(page);
  const usesPassword = ["sign-in", "sign-up", "reset-password"].includes(page);
  const needsToken = page === "verify-email" || page === "reset-password";
  const validEmail = !usesEmail || authEmailSchema.safeParse(email).success;
  const validPassword = !usesPassword || authPasswordSchema.safeParse(password).success;
  const errorText = failure
    ? t(`auth.errors.${failure.code}`) +
      (failure.retryAfter ? " " + t("auth.retryAfter", { seconds: failure.retryAfter }) : "")
    : "";
  async function run(provider?: AuthOAuthProvider) {
    if (operation.current || complete) return;
    setInvalid(true);
    if (!provider && (!validEmail || !validPassword || (needsToken && !token))) return;
    const request = new AbortController();
    const cancelled = () => request.signal.aborted;
    operation.current = request;
    setPending(true);
    setFailure(null);
    const changesIdentity = Boolean(provider) || page === "sign-in" || page === "reset-password";
    if (changesIdentity) controller.beginChange();
    const scope = changesIdentity ? controller.signal : request.signal;
    const signal = AbortSignal.any([request.signal, scope]);
    const obsolete = () => signal.aborted;
    try {
      if (provider) {
        const url = await controller.api.oauth(provider, false, signal);
        if (!obsolete()) window.location.assign(url);
        return;
      }
      const input = { email, password };
      if (page === "sign-in") await controller.api.signIn(input, signal);
      else if (page === "sign-up") await controller.api.signUp(input, signal);
      else if (page === "resend") await controller.api.resend({ email }, signal);
      else if (page === "forgot-password") await controller.api.forgot({ email }, signal);
      else if (page === "verify-email") await controller.api.verify({ token }, signal);
      else if (page === "reset-password") {
        await controller.api.reset({ token, newPassword: password }, signal);
      }
      if (obsolete()) return;
      setPassword("");
      setComplete(true);
      setToken(undefined);
      if (page === "sign-in") {
        await controller.changed();
        if (!cancelled()) navigateAccount(destination);
      } else if (page === "reset-password") await controller.changed();
    } catch (error) {
      if (!obsolete()) {
        setPassword("");
        setFailure(
          error instanceof AccountFailure ? error : new AccountFailure("AUTH_UNAVAILABLE"),
        );
        if (changesIdentity) await controller.changed();
      }
    } finally {
      if (operation.current === request) {
        if (obsolete()) setPassword("");
        operation.current = null;
        setPending(false);
      }
    }
  }
  const expired = needsToken && (!token || failure?.code === "AUTH_INVALID_TOKEN") && !complete;
  return (
    <AccountLayout title={t(`auth.titles.${page}`)} sandboxEnabled={sandboxEnabled}>
      {page === "sign-in" || page === "sign-up" ? (
        <p className="text-body text-text-secondary">{t("auth.guestSeparation")}</p>
      ) : null}
      {errorText && !expired ? (
        <p role="alert" className="text-body text-danger">
          {errorText}
        </p>
      ) : null}
      {page === "complete" ? (
        <>
          {entry.result && account.state.phase === "checking" ? <p>{t("auth.checking")}</p> : null}
          {entry.result && account.state.session ? (
            <>
              <p>{t(entry.result === "linked" ? "auth.linked" : "auth.signedIn")}</p>
              <a
                href={entry.result === "linked" ? "/account" : "/"}
                className="text-accent underline"
              >
                {t("auth.continue")}
              </a>
            </>
          ) : !entry.error && account.state.phase !== "checking" ? (
            <p>{t("auth.sessionEnded")}</p>
          ) : null}
        </>
      ) : complete ? (
        <p role="status">{t(`auth.success.${page}`)}</p>
      ) : expired ? (
        <p role="alert">{t("auth.expiredLink")}</p>
      ) : (
        <>
          {methods?.email ? (
            <form
              noValidate
              className="grid min-w-0 gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              {usesEmail ? (
                <Field
                  name="email"
                  label={t("auth.email")}
                  type="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  readOnly={pending}
                  onChange={(event) => setEmail(event.target.value)}
                  error={invalid && !validEmail ? t("auth.emailInvalid") : undefined}
                />
              ) : null}
              {usesPassword ? (
                <Field
                  name="password"
                  label={t(page === "reset-password" ? "auth.newPassword" : "auth.password")}
                  secret
                  autoComplete={page === "sign-in" ? "current-password" : "new-password"}
                  value={password}
                  readOnly={pending}
                  onChange={(event) => setPassword(event.target.value)}
                  hint={t("auth.passwordHint")}
                  error={invalid && !validPassword ? t("auth.passwordHint") : undefined}
                />
              ) : null}
              {page === "verify-email" ? <p>{t("auth.verifyHint")}</p> : null}
              <Button variant="primary" type="submit" aria-disabled={pending}>
                {t(`auth.actions.${page}`)}
              </Button>
              {pending ? <p role="status">{t("auth.pending")}</p> : null}
            </form>
          ) : (
            <p>
              {t(
                methodError
                  ? "auth.methodsError"
                  : methods
                    ? "auth.emailDisabled"
                    : "auth.checking",
              )}
            </p>
          )}
          {methodError ? (
            <Button variant="secondary" onClick={() => setReload(reload + 1)}>
              {t("auth.retry")}
            </Button>
          ) : null}
          {page === "sign-in" || page === "sign-up" ? (
            <div className="grid gap-3 border-t border-divider pt-5">
              {methods?.providers.map((provider) => (
                <Button
                  key={provider}
                  variant="secondary"
                  aria-disabled={pending}
                  onClick={() => void run(provider)}
                >
                  {t(`auth.providers.${provider}`)}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      )}
      <nav
        aria-label={t("auth.navigation")}
        className="flex flex-wrap gap-x-5 gap-y-3 text-label text-accent underline"
      >
        {page !== "sign-in" ? (
          <a href={link("sign-in")}>{t("auth.signIn")}</a>
        ) : (
          <>
            <a href={link("sign-up")}>{t("auth.signUp")}</a>
            <a href={link("forgot-password")}>{t("auth.forgot")}</a>
          </>
        )}
        {["sign-in", "sign-up", "verify-email", "resend"].includes(page) ? (
          <a href={link("resend")}>{t("auth.resend")}</a>
        ) : null}
        {page === "reset-password" ? (
          <a href={link("forgot-password")}>{t("auth.freshReset")}</a>
        ) : null}
        <a href={destination}>{t("auth.back")}</a>
      </nav>
    </AccountLayout>
  );
}
