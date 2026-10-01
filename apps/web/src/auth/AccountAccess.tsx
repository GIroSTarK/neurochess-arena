import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";

import { Avatar } from "./Avatar";
import { useAccount } from "./context";
import { authHref, safeReturnTo } from "./navigation";

export function AccountAccess() {
  const { t } = useTranslation();
  const account = useAccount();
  const returnTo = safeReturnTo(window.location.pathname + window.location.search);
  if (account?.state.phase === "account" && account.state.profile) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <a
          href={"/account" + (returnTo === "/" ? "" : "?returnTo=" + encodeURIComponent(returnTo))}
          className="flex min-h-target max-w-full min-w-0 items-center gap-2 text-text hover:text-accent"
        >
          <Avatar avatar={account.state.profile.avatar} />
          <span className="max-w-48 break-words">
            {account.state.profile.username ?? t("account.profile")}
          </span>
        </a>
        <Button variant="quiet" padding="compact" onClick={() => void account.controller.signOut()}>
          {t("account.signOut")}
        </Button>
        {account.state.issue ? (
          <p role="alert" className="w-full max-w-xl text-label text-danger">
            {t(`account.errors.${account.state.issue}`)}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <span>
        {t(account?.state.phase === "guest" || !account ? "setup.session" : "account.label")}
      </span>
      <a
        className="inline-flex min-h-target items-center text-accent underline"
        href={authHref("sign-in", returnTo)}
      >
        {t("account.signIn")}
      </a>
    </div>
  );
}
