import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { type AiIdentity, createAiApi } from "../api/ai-client";
import { resultTitle } from "../arena/result";
import { AccountFrame } from "../auth/AccountFrame";
import { authHref } from "../auth/navigation";
import { Button } from "../ui/Button";

import { HistoryController } from "./controller";

export function GuestHistory({ sandboxEnabled }: { readonly sandboxEnabled: boolean }) {
  const { t } = useTranslation();
  return (
    <AccountFrame title={t("history.title")} sandboxEnabled={sandboxEnabled} page="history">
      <p>{t("history.guest")}</p>
      <a
        className="inline-flex min-h-target items-center text-accent underline"
        href={authHref("sign-in", "/history")}
      >
        {t("account.signIn")}
      </a>
      <a className="inline-flex min-h-target items-center text-accent underline" href="/">
        {t("history.arena")}
      </a>
    </AccountFrame>
  );
}

export function HistoryScreen({
  apiBaseUrl,
  identity,
  username,
  sandboxEnabled,
}: {
  readonly apiBaseUrl: string;
  readonly identity: AiIdentity;
  readonly username: string;
  readonly sandboxEnabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [controller] = useState(
    () => new HistoryController(createAiApi(apiBaseUrl, { identity }), identity.signal),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <AccountFrame title={t("history.title")} sandboxEnabled={sandboxEnabled} page="history">
      <p className="text-body text-text-secondary">{t("history.description")}</p>
      <a href="/" className="inline-flex min-h-target items-center text-accent underline">
        {t("history.arena")}
      </a>
      {state.phase === "loading" ? <p role="status">{t("history.loading")}</p> : null}
      {state.phase === "error" ? (
        <div className="grid gap-3">
          <p role="alert">{t("history.loadError")}</p>
          <Button variant="secondary" onClick={controller.retry}>
            {t("history.retry")}
          </Button>
        </div>
      ) : null}
      {state.result?.games.length === 0 ? <p>{t("history.empty")}</p> : null}
      <ul className="grid min-w-0 gap-4" aria-label={t("history.list")}>
        {state.result?.games.map((game) => {
          const date = dateFormat.format(new Date(game.finishedAt));
          return (
            <li
              key={game.gameId}
              className="grid min-w-0 gap-3 rounded-control border border-divider bg-surface-raised p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="rounded-control border border-control-border px-2 py-1 text-label">
                  {t(`history.states.${game.state}`)}
                </span>
                <time dateTime={game.finishedAt} className="text-label text-text-secondary">
                  {date}
                </time>
              </div>
              <p className="text-label text-text-secondary">
                {t(`history.modes.${game.configuration.mode}`)}
              </p>
              <dl className="grid min-w-0 gap-2">
                {(["white", "black"] as const).map((color) => {
                  const seat = game.configuration.seats[color];
                  return (
                    <div key={color} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3">
                      <dt className="text-text-secondary">{t(`players.${color}`)}</dt>
                      <dd className="min-w-0 wrap-anywhere">
                        {seat.type === "human"
                          ? username
                          : t("history.model", {
                              model: seat.modelId,
                              provider: t(`setup.providers.${seat.provider}`),
                            })}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <p>
                {t("game.resultWithScore", {
                  result: resultTitle(game, t),
                  reason: t(`reasons.${game.terminationReason}`),
                  score: game.result,
                })}
              </p>
              <a
                href={"/?game=" + game.gameId}
                className="inline-flex min-h-target items-center text-accent underline"
                aria-label={t("history.replayLabel", { date, result: resultTitle(game, t) })}
              >
                {t("history.replay")}
              </a>
            </li>
          );
        })}
      </ul>
      {state.result ? (
        <div className="grid gap-3">
          <p role="status">{t("history.page", { number: state.page + 1 })}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              aria-disabled={state.phase === "loading" || state.page === 0}
              onClick={controller.newer}
            >
              {t("history.newer")}
            </Button>
            <Button
              variant="secondary"
              aria-disabled={state.phase === "loading" || !state.result.nextCursor}
              onClick={controller.older}
            >
              {t("history.older")}
            </Button>
            <Button
              variant="quiet"
              aria-disabled={state.phase === "loading"}
              onClick={controller.reload}
            >
              {t("history.refresh")}
            </Button>
          </div>
        </div>
      ) : null}
    </AccountFrame>
  );
}
