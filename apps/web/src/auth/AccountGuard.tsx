import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useMatches } from "react-router";

import { useAppRoute } from "../app/route-context";
import { Button } from "../ui/Button";

import { AccountFrame } from "./AccountFrame";
import { useRequiredAccount } from "./context";
import { authHref } from "./navigation";
import { ProfileScreen } from "./ProfileScreen";
import type { PublicRouteData } from "./route-data";
import { useRouteAuthEntry } from "./useRouteAuthEntry";

export function GuestContinuation() {
  const { t } = useTranslation();
  const { commands: fetcher } = useRequiredAccount();
  return (
    <fetcher.Form method="post" action="/account">
      <Button
        type="submit"
        name="intent"
        value="guest"
        variant="secondary"
        aria-disabled={fetcher.state !== "idle"}
      >
        {t("account.guest")}
      </Button>
    </fetcher.Form>
  );
}

export function PublicPage({
  children,
  allowGuest = true,
  requireProfile = true,
}: {
  readonly children: ReactNode;
  readonly allowGuest?: boolean;
  readonly requireProfile?: boolean;
}) {
  const { t } = useTranslation();
  const { controller, state } = useRequiredAccount();
  const { sandboxEnabled, authEntry } = useAppRoute();
  const entry = useRouteAuthEntry(authEntry);
  const matches = useMatches();
  const result = matches.findLast((match) => match.loaderData)?.loaderData as
    PublicRouteData | undefined;
  if (state.deletion === "deleted" && state.phase !== "account") {
    return (
      <AccountFrame title={t("account.deletion.deleted")} sandboxEnabled={sandboxEnabled}>
        <p role="status">{t("account.deletion.done")}</p>
        <GuestContinuation />
      </AccountFrame>
    );
  }
  const current = result?.generation === state.revision && result.data !== null;
  if (current && state.phase === "account") {
    if (requireProfile && !state.profile?.completed) {
      return (
        <ProfileScreen
          key={state.revision}
          returnTo={entry.returnTo}
          sandboxEnabled={sandboxEnabled}
        />
      );
    }
    return <Fragment key={state.revision}>{children}</Fragment>;
  }
  if (current && allowGuest && state.phase === "guest") {
    return <Fragment key={state.revision}>{children}</Fragment>;
  }
  const required = state.phase === "required" || (state.phase === "guest" && !allowGuest);
  return (
    <AccountFrame
      title={t(
        required
          ? "account.required"
          : state.phase === "unavailable"
            ? "account.unavailable"
            : "account.loading",
      )}
      sandboxEnabled={sandboxEnabled}
    >
      {state.deletion === "uncertain" ? (
        <p role="alert">{t("account.deletion.uncertain")}</p>
      ) : null}
      {state.issue ? <p role="alert">{t(`account.errors.${state.issue}`)}</p> : null}
      {required ? (
        <>
          <p>{t("account.sessionEnded")}</p>
          <Link
            to={authHref("sign-in", entry.returnTo)}
            className="inline-flex min-h-target items-center text-accent underline"
          >
            {t("account.signIn")}
          </Link>
          <GuestContinuation />
        </>
      ) : state.phase === "unavailable" ? (
        <Button variant="primary" onClick={() => void controller.refresh()}>
          {t("account.retry")}
        </Button>
      ) : (
        <p role="status">{t("account.working")}</p>
      )}
    </AccountFrame>
  );
}
