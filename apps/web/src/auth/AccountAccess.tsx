import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";

import { authHref, safeReturnTo, withReturnTo } from "../app/route-urls";
import { Button } from "../ui/Button";
import { TextLink } from "../ui/TextLink";

import { Avatar } from "./Avatar";
import { useAccount, useRequiredAccount } from "./context";

function SignOutButton() {
  const { t } = useTranslation();
  const { commands: fetcher, state } = useRequiredAccount();
  return (
    <fetcher.Form method="post" action="/account">
      <input type="hidden" name="expectedAccount" value={state.session?.user.id ?? ""} />
      <Button
        type="submit"
        name="intent"
        value="sign-out"
        variant="quiet"
        padding="compact"
        aria-disabled={fetcher.state !== "idle"}
      >
        {t("account.signOut")}
      </Button>
    </fetcher.Form>
  );
}

export function AccountAccess() {
  const { t } = useTranslation();
  const account = useAccount();
  const location = useLocation();
  const returnTo = safeReturnTo(location.pathname + location.search);
  if (account?.state.phase === "account" && account.state.profile) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link
          to={withReturnTo("/account", returnTo)}
          className="flex min-h-target max-w-full min-w-0 items-center gap-2 text-text hover:text-accent"
        >
          <Avatar avatar={account.state.profile.avatar} />
          <span className="max-w-48 min-w-0 break-words">
            {account.state.profile.username ?? t("account.profile")}
          </span>
        </Link>
        <TextLink to={withReturnTo("/account/credentials", returnTo)}>
          {t("credentials.navigation")}
        </TextLink>
        <SignOutButton />
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
      <TextLink to={authHref("sign-in", returnTo)}>{t("account.signIn")}</TextLink>
    </div>
  );
}
