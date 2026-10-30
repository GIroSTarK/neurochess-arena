import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { AccountField } from "../auth/account-field";
import type { PublicAccess } from "../routing/route-runtime";
import { authHref, gameHref, withReturnTo } from "../routing/route-urls";
import { PageLayout } from "../shell/page-layout";
import { Button } from "../ui/button";
import { TextLink } from "../ui/text-link";

import type { RoomEntryMemory } from "./entry-memory";

export type RoomEntrySubmit = (intent: string, fields: Record<string, string>) => void;

export function RoomEntryScreen({
  mode,
  access,
  existingGameId,
  memory,
  onSubmit,
}: {
  readonly mode: "setup" | "join";
  readonly access: PublicAccess;
  readonly existingGameId: string | null;
  readonly memory: RoomEntryMemory;
  readonly onSubmit: RoomEntrySubmit;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(memory.subscribe, memory.getSnapshot);
  const [color, setColor] = useState<"white" | "black">("white");
  const blocked = state.busy || state.pending !== null;
  const admittedIdentity = access === "guest" || access === "account";
  const returnTo = mode === "join" ? "/rooms/join" : "/rooms";
  return (
    <PageLayout
      title={t(mode === "join" ? "rooms.joinTitle" : "rooms.title")}
      description={t(mode === "join" ? "rooms.joinDescription" : "rooms.description")}
    >
      {mode === "setup" ? (
        <>
          {access === "account" ? (
            existingGameId ? (
              <div className="grid gap-3">
                <p>{t("rooms.errors.occupied")}</p>
                <TextLink to={gameHref("arena", existingGameId)}>{t("rooms.returnGame")}</TextLink>
              </div>
            ) : (
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!blocked) onSubmit("create", { ownerColor: color });
                }}
              >
                <fieldset className="grid gap-2">
                  <legend className="mb-2 text-label font-semibold">{t("rooms.color")}</legend>
                  <div className="flex flex-wrap gap-3">
                    {(["white", "black"] as const).map((value) => (
                      <label
                        key={value}
                        className="flex min-h-target cursor-pointer items-center gap-3 rounded-control border border-control-border px-4 py-2"
                      >
                        <input
                          type="radio"
                          name="color"
                          value={value}
                          checked={color === value}
                          aria-disabled={blocked}
                          onChange={() => {
                            if (!blocked) setColor(value);
                          }}
                        />
                        {t(`players.${value}`)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <p className="text-label text-text-secondary">{t("rooms.slot")}</p>
                <Button variant="primary" type="submit" aria-disabled={blocked}>
                  {t("rooms.create")}
                </Button>
              </form>
            )
          ) : (
            <p>{t("rooms.accountRequired")}</p>
          )}
          <TextLink to="/rooms/join">{t("rooms.joinLink")}</TextLink>
        </>
      ) : (
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked && admittedIdentity) onSubmit("join", {});
          }}
        >
          <AccountField
            label={t("rooms.input")}
            value={state.input}
            maxLength={1024}
            autoComplete="off"
            spellCheck={false}
            readOnly={blocked}
            onChange={(event) => memory.setInput(event.target.value)}
          />
          <p className="text-label text-text-secondary">{t("rooms.authDeparture")}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              aria-disabled={blocked || !state.input.trim()}
              onClick={() => onSubmit("resolve", {})}
            >
              {t("rooms.check")}
            </Button>
            {admittedIdentity ? (
              <Button
                variant="primary"
                type="submit"
                aria-disabled={blocked || !state.input.trim()}
              >
                {t(access === "guest" ? "rooms.joinGuest" : "rooms.join")}
              </Button>
            ) : null}
          </div>
          {state.resolution ? <p role="status">{t(`rooms.${state.resolution}`)}</p> : null}
        </form>
      )}
      {access === "onboarding" ? (
        <TextLink to={withReturnTo("/account", returnTo)}>{t("rooms.completeProfile")}</TextLink>
      ) : access !== "account" ? (
        <TextLink to={authHref("sign-in", returnTo)}>{t("account.signIn")}</TextLink>
      ) : null}
      {state.issue ? (
        <p role="alert" className="text-danger">
          {t(`rooms.errors.${state.issue}`)}
        </p>
      ) : null}
      {state.pending === "create" || state.pending === "join" ? (
        <Button
          variant="secondary"
          aria-disabled={state.busy}
          onClick={() => onSubmit(state.pending === "create" ? "retry-create" : "retry-join", {})}
        >
          {t("rooms.retry")}
        </Button>
      ) : null}
      {state.busy ? <p role="status">{t("rooms.working")}</p> : null}
    </PageLayout>
  );
}
