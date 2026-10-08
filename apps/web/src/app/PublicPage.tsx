import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMatches } from "react-router";

import { AccountFrame } from "../auth/AccountFrame";
import { useRequiredAccount } from "../auth/context";
import type { PublicRouteData } from "../auth/route-data";
import { useRouteAuthEntry } from "../auth/useRouteAuthEntry";
import { ProfileScreen } from "../profile/ProfileScreen";
import { Button } from "../ui/Button";
import { TextLink } from "../ui/TextLink";

import { useAppRoute } from "./route-context";
import { authHref } from "./route-urls";

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
  const [initialRevision] = useState(state.revision);
  const { authEntry } = useAppRoute();
  const entry = useRouteAuthEntry(authEntry);
  const matches = useMatches();
  const result = matches.findLast((match) => match.loaderData)?.loaderData as
    PublicRouteData | undefined;
  if (state.deletion === "deleted" && state.phase !== "account") {
    return (
      <AccountFrame title={t("account.deletion.deleted")} focusHeading>
        <p role="status">{t("account.deletion.done")}</p>
        <GuestContinuation />
      </AccountFrame>
    );
  }
  const current = result?.generation === state.revision && result.data !== null;
  if (current && state.phase === "account") {
    if (requireProfile && state.profile && !state.profile.completed) {
      return (
        <ProfileScreen key={state.revision} profile={state.profile} returnTo={entry.returnTo} />
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
      focusHeading={
        state.revision !== initialRevision && (required || state.phase === "unavailable")
      }
    >
      {state.deletion === "uncertain" ? (
        <p role="alert">{t("account.deletion.uncertain")}</p>
      ) : null}
      {state.issue ? <p role="alert">{t(`account.errors.${state.issue}`)}</p> : null}
      {required ? (
        <>
          <p>{t("account.sessionEnded")}</p>
          <TextLink to={authHref("sign-in", entry.returnTo)}>{t("account.signIn")}</TextLink>
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
