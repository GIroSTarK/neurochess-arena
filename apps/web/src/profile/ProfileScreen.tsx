import type { ProfileResponse } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { AccountField } from "../auth/AccountField";
import { AccountFrame } from "../auth/AccountFrame";
import type { AccountActionData } from "../auth/action-data";
import { Avatar } from "../auth/Avatar";
import { useRequiredAccount } from "../auth/context";
import { Button } from "../ui/Button";

import { AccountDeletion } from "./AccountDeletion";

export function ProfileScreen({
  returnTo,
  sandboxEnabled,
  profile,
}: {
  readonly returnTo: string;
  readonly sandboxEnabled: boolean;
  readonly profile: ProfileResponse;
}) {
  const { t } = useTranslation();
  const { state, profileCommands: fetcher } = useRequiredAccount();
  const reset = fetcher.reset;
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const [removingAvatar, setRemovingAvatar] = useState(false);
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data?.generation === state.revision ? fetcher.data.data : null;
  const error = outcome && "error" in outcome ? outcome.error : null;
  const invalid = outcome && "invalid" in outcome;
  const saved = outcome && "notice" in outcome && outcome.notice === "saved";
  const action = `/account${returnTo === "/" ? "" : "?returnTo=" + encodeURIComponent(returnTo)}`;
  const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
  useEffect(() => {
    const element = form.current;
    const clear = () => {
      element?.reset();
      reset();
    };
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      element?.reset();
    };
  }, [reset]);
  function save(remove = false) {
    if (busy || pending.current || !form.current || !state.session) return;
    const data = remove ? new FormData() : new FormData(form.current);
    data.set("intent", remove ? "remove-avatar" : "save-profile");
    data.set("expectedAccount", state.session.user.id);
    setRemovingAvatar(remove);
    pending.current = true;
    reset();
    void fetcher.submit(data, { method: "post", action }).finally(() => {
      pending.current = false;
    });
  }
  const [acknowledged, setAcknowledged] = useState<AccountActionData | undefined>(undefined);
  if (saved && fetcher.data !== acknowledged) {
    setAcknowledged(fetcher.data);
    if (!removingAvatar) setUsernameDraft(null);
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
          <Button variant="secondary" aria-disabled={busy} onClick={() => save(true)}>
            {t("account.removeAvatar")}
          </Button>
        ) : null}
        <p className="text-label text-text-secondary">{t("account.avatarHint")}</p>
      </div>
      <fetcher.Form
        ref={form}
        method="post"
        action={action}
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <AccountField
          name="username"
          label={t("account.username")}
          value={usernameDraft ?? profile.username ?? ""}
          onChange={(event) => setUsernameDraft(event.currentTarget.value)}
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
      </fetcher.Form>
      {profile.completed ? (
        <Link to={returnTo} className="inline-flex min-h-target items-center text-accent underline">
          {t("account.return")}
        </Link>
      ) : null}
      <AccountDeletion />
    </AccountFrame>
  );
}
