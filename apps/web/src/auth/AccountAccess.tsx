import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";

import { Avatar } from "./Avatar";
import { useAccount } from "./context";
import { authHref } from "./navigation";

export function AccountAccess() {
  const { t } = useTranslation();
  const account = useAccount();
  const profile = account?.state.profile;
  return (
    <span className="flex max-w-full flex-wrap items-center justify-end gap-3 text-label">
      {account?.state.session ? (
        <>
          <a
            href="/account"
            className="inline-flex min-h-target min-w-0 items-center gap-2 text-text hover:underline"
          >
            {profile ? <Avatar profile={profile} /> : null}
            <span>{profile?.username ?? t("auth.account")}</span>
          </a>
          <Button variant="quiet" onClick={() => void account.controller.signOut()}>
            {t("auth.signOut")}
          </Button>
        </>
      ) : (
        <>
          <span>{t("setup.session")}</span>
          <a
            href={authHref("sign-in")}
            className="inline-flex min-h-target items-center text-accent underline"
          >
            {t("auth.signIn")}
          </a>
        </>
      )}
    </span>
  );
}
