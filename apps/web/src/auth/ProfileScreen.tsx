import { type AuthOAuthProvider, usernameSchema } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CredentialSettings } from "../credentials/Settings";
import { Button } from "../ui/Button";

import { AccountDeletion } from "./AccountDeletion";
import { AccountLayout } from "./AccountLayout";
import { Avatar } from "./Avatar";
import { AccountFailure } from "./client";
import { useRequiredAccount } from "./context";
import { Field } from "./Field";
import { authHref, navigateAccount, safeReturn } from "./navigation";

export function ProfileScreen({ sandboxEnabled }: { readonly sandboxEnabled: boolean }) {
  const { t } = useTranslation();
  const { state, controller } = useRequiredAccount();
  const profile = state.profile;
  if (!profile) throw new Error("PROFILE_REQUIRED");
  const onboardingRequired = profile.onboardingRequired;
  const [username, setUsername] = useState(profile.username ?? "");
  const [avatar, setAvatar] = useState<"initials" | "provider">(
    profile.avatar.source === "initials" ? "initials" : "provider",
  );
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<AccountFailure | null>(null);
  const [providers, setProviders] = useState<AuthOAuthProvider[]>([]);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void controller.api.methods(request.signal).then(
      (methods) => {
        if (!request.signal.aborted) setProviders(methods.providers);
      },
      () => undefined,
    );
    return () => {
      request.abort();
      operation.current?.abort();
    };
  }, [controller]);
  async function run(provider?: AuthOAuthProvider) {
    if (operation.current) return;
    if (!provider && !usernameSchema.safeParse(username).success) {
      setInvalid(true);
      return;
    }
    const request = new AbortController();
    const scope = controller.signal;
    const signal = AbortSignal.any([request.signal, scope]);
    operation.current = request;
    setPending(true);
    setFailure(null);
    setSaved(false);
    setInvalid(false);
    try {
      if (provider) {
        const url = await controller.api.oauth(provider, true, signal);
        if (!signal.aborted) window.location.assign(url);
      } else {
        const result = await controller.api.updateProfile(
          { username, avatar },
          onboardingRequired,
          signal,
        );
        if (signal.aborted) return;
        controller.setProfile(result, scope);
        setUsername(result.username ?? "");
        setSaved(true);
        if (onboardingRequired) {
          navigateAccount(safeReturn(window.location.pathname + window.location.search));
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof AccountFailure &&
        ["PROFILE_UNAUTHORIZED", "AUTH_UNAUTHORIZED"].includes(error.code)
      ) {
        controller.expired();
      } else {
        setFailure(
          error instanceof AccountFailure ? error : new AccountFailure("PROFILE_UNAVAILABLE"),
        );
      }
    } finally {
      if (operation.current === request) {
        operation.current = null;
        setPending(false);
      }
    }
  }
  const error = failure ? t(`auth.errors.${failure.code}`) : "";
  return (
    <AccountLayout
      title={t(profile.onboardingRequired ? "auth.onboarding" : "auth.profile")}
      sandboxEnabled={sandboxEnabled}
    >
      <p className="text-body text-text-secondary">
        {t(profile.onboardingRequired ? "auth.onboardingHint" : "auth.profileHint")}
      </p>
      <Avatar profile={profile} />
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Field
          label={t("auth.username")}
          name="username"
          autoComplete="nickname"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          readOnly={pending}
          onChange={(event) => setUsername(event.target.value)}
          hint={t("auth.usernameHint")}
          error={
            invalid
              ? t("auth.usernameHint")
              : failure?.code === "USERNAME_UNAVAILABLE"
                ? error
                : undefined
          }
        />
        {profile.providerAvatar ? (
          <fieldset className="grid gap-3">
            <legend className="mb-2 text-label font-semibold">{t("auth.avatar")}</legend>
            {(["initials", "provider"] as const).map((value) => (
              <label key={value} className="flex min-h-target items-center gap-3 text-body">
                <input
                  type="radio"
                  name="avatar"
                  value={value}
                  checked={avatar === value}
                  aria-disabled={pending}
                  onChange={() => {
                    if (!pending) setAvatar(value);
                  }}
                />
                {t(value === "initials" ? "auth.initials" : "auth.providerAvatar")}
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="text-label text-text-secondary">{t("auth.initialsOnly")}</p>
        )}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        {saved ? <p role="status">{t("auth.profileSaved")}</p> : null}
        <Button variant="primary" type="submit" aria-disabled={pending}>
          {t(profile.onboardingRequired ? "auth.finishProfile" : "auth.saveProfile")}
        </Button>
        {pending ? <p>{t("auth.pending")}</p> : null}
      </form>
      {!profile.onboardingRequired ? (
        <>
          <CredentialSettings />
          {providers.length ? (
            <div className="grid gap-3 border-t border-divider pt-5">
              <h2 className="text-section font-semibold">{t("auth.linkAccounts")}</h2>
              <p className="text-label text-text-secondary">{t("auth.linkHint")}</p>
              {providers.map((provider) => (
                <Button
                  key={provider}
                  variant="secondary"
                  aria-disabled={pending}
                  onClick={() => void run(provider)}
                >
                  {t(`auth.link.${provider}`)}
                </Button>
              ))}
            </div>
          ) : null}
          <a href={authHref("sign-in")} className="text-accent underline">
            {t("auth.switchAccount")}
          </a>
          <a href="/" className="text-accent underline">
            {t("auth.back")}
          </a>
        </>
      ) : null}
      <AccountDeletion />
    </AccountLayout>
  );
}
