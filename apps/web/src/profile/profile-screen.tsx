import type { ProfileResponse } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AccountField } from "../auth/account-field";
import { AccountFrame } from "../auth/account-frame";
import type { AccountActionData } from "../auth/action-data";
import { Avatar } from "../auth/avatar";
import { useRequiredAccount } from "../auth/context";
import { withReturnTo } from "../routing/route-urls";
import { Button } from "../ui/button";
import { TextLink } from "../ui/text-link";

import { AccountDeletion } from "./account-deletion";

export function ProfileScreen({
  returnTo,
  profile,
}: {
  readonly returnTo: string;
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
  const action = withReturnTo("/account", returnTo);
  const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
  useEffect(() => {
    const element = form.current;
    const clear = () => {
      element?.reset();
      reset();
    };
    window.addEventListener("pagehide", clear);
    // No reset on cleanup: it only precedes unmount, and StrictMode's dev remount would
    // revert a username edit already in progress.
    return () => window.removeEventListener("pagehide", clear);
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
      description={t("account.profileHint")}
      width="content"
      actions={
        profile.completed ? <TextLink to={returnTo}>{t("account.return")}</TextLink> : undefined
      }
    >
      <div className="flex max-w-xl flex-wrap items-center gap-4">
        <Avatar avatar={profile.avatar} />
        <p className="min-w-0 flex-[1_1_16rem] text-label text-text-secondary">
          {t("account.avatarHint")}
        </p>
        {profile.avatar.source !== "initials" ? (
          <Button variant="secondary" aria-disabled={busy} onClick={() => save(true)}>
            {t("account.removeAvatar")}
          </Button>
        ) : null}
      </div>
      <fetcher.Form
        ref={form}
        method="post"
        action={action}
        noValidate
        className="grid max-w-xl min-w-0 gap-4"
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
        <Button
          variant="primary"
          type="submit"
          aria-disabled={busy}
          className="sm:justify-self-start"
        >
          {t(profile.completed ? "account.saveProfile" : "account.finishProfile")}
        </Button>
      </fetcher.Form>
      <AccountDeletion />
    </AccountFrame>
  );
}
