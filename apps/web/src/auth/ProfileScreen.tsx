import { profileUsernameSchema } from "@neurochess/contracts";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { accountError, type AccountErrorCode } from "../api/auth-client";
import { Button } from "../ui/Button";

import { AccountField } from "./AccountField";
import { AccountFrame } from "./AccountFrame";
import { Avatar } from "./Avatar";
import { useRequiredAccount } from "./context";

export function ProfileScreen({
  returnTo,
  sandboxEnabled,
}: {
  readonly returnTo: string;
  readonly sandboxEnabled: boolean;
}) {
  const { t } = useTranslation();
  const { controller, state } = useRequiredAccount();
  const profile = state.profile;
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountErrorCode | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!profile) return null;
  async function save(remove = false) {
    if (pending.current || !form.current) return;
    const username = profileUsernameSchema.safeParse(new FormData(form.current).get("username"));
    if (!remove && !username.success) {
      setInvalid(true);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    setInvalid(false);
    setSaved(false);
    try {
      await controller.saveProfile(
        remove ? { avatar: "remove" } : { username: username.success ? username.data : "" },
      );
      setSaved(true);
      if (!profile?.completed && !remove) window.location.assign(returnTo);
    } catch (error) {
      if (accountError(error) !== "cancelled") setError(accountError(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <AccountFrame
      title={t(profile.completed ? "account.profile" : "account.onboarding")}
      sandboxEnabled={sandboxEnabled}
    >
      <p className="text-body text-text-secondary">{t("account.profileHint")}</p>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar avatar={profile.avatar} />
        {profile.avatar.source !== "initials" ? (
          <Button variant="secondary" aria-disabled={busy} onClick={() => void save(true)}>
            {t("account.removeAvatar")}
          </Button>
        ) : null}
        <p className="text-label text-text-secondary">{t("account.avatarHint")}</p>
      </div>
      <form
        ref={form}
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <AccountField
          key={`${state.session?.user.id ?? ""}:${profile.username ?? ""}`}
          name="username"
          label={t("account.username")}
          defaultValue={profile.username ?? ""}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={24}
          readOnly={busy}
          hint={t("account.usernameHint")}
          error={invalid ? t("account.usernameInvalid") : null}
        />
        {error ? (
          <p role="alert" className="text-danger">
            {t(`account.errors.${error}`)}
          </p>
        ) : null}
        {busy || saved ? (
          <p role="status">{t(busy ? "account.working" : "account.saved")}</p>
        ) : null}
        <Button variant="primary" type="submit" aria-disabled={busy}>
          {t(profile.completed ? "account.saveProfile" : "account.finishProfile")}
        </Button>
      </form>
      {profile.completed ? (
        <a href={returnTo} className="inline-flex min-h-target items-center text-accent underline">
          {t("account.return")}
        </a>
      ) : null}
    </AccountFrame>
  );
}
