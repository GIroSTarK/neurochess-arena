import type { GameHistoryEntry } from "@neurochess/contracts";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { type AiIdentity, createAiApi } from "../api/ai-client";
import { resultTitle } from "../arena/result";
import { AccountFrame } from "../auth/AccountFrame";
import { authHref } from "../auth/navigation";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

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

function Players({
  game,
  username,
}: {
  readonly game: GameHistoryEntry;
  readonly username: string;
}) {
  const { t } = useTranslation();
  return (
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
  const listHeadingId = useId();
  const listHeading = useRef<HTMLHeadingElement>(null);
  // A deletion attempt can remove the row that opened the dialog, so focus the list instead.
  const focusList = useRef(false);
  const { deletion } = state;
  useEffect(() => {
    if (deletion === null && focusList.current) {
      focusList.current = false;
      listHeading.current?.focus();
    }
  }, [deletion]);
  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const clearing = deletion?.target === "all";
  const hasGames = state.result !== null && (state.page > 0 || state.result.games.length > 0);
  return (
    <AccountFrame title={t("history.title")} sandboxEnabled={sandboxEnabled} page="history">
      <p className="text-body text-text-secondary">{t("history.description")}</p>
      <a href="/" className="inline-flex min-h-target items-center text-accent underline">
        {t("history.arena")}
      </a>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id={listHeadingId}
          ref={listHeading}
          tabIndex={-1}
          className="text-section font-semibold"
        >
          {t("history.list")}
        </h2>
        <Button
          variant="secondary"
          aria-disabled={!hasGames || state.phase === "loading"}
          onClick={() => controller.requestDeletion("all")}
        >
          {t("history.clear")}
        </Button>
      </div>
      {state.notice ? <p role="status">{t(`history.${state.notice}`)}</p> : null}
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
      <ul className="grid min-w-0 gap-4" aria-labelledby={listHeadingId}>
        {state.result?.games.map((game) => {
          const date = dateFormat.format(new Date(game.finishedAt));
          const result = resultTitle(game, t);
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
              <Players game={game} username={username} />
              <p>
                {t("game.resultWithScore", {
                  result,
                  reason: t(`reasons.${game.terminationReason}`),
                  score: game.result,
                })}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <a
                  href={"/?game=" + game.gameId}
                  className="inline-flex min-h-target items-center text-accent underline"
                  aria-label={t("history.replayLabel", { date, result })}
                >
                  {t("history.replay")}
                </a>
                <Button
                  variant="secondary"
                  aria-label={t("history.deleteLabel", { date, result })}
                  onClick={() => controller.requestDeletion(game)}
                >
                  {t("history.delete")}
                </Button>
              </div>
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
      {deletion ? (
        <Dialog
          title={t(clearing ? "history.clearTitle" : "history.deleteTitle")}
          description={t(clearing ? "history.clearDescription" : "history.deleteDescription")}
          onCancel={controller.cancelDeletion}
        >
          {deletion.target === "all" ? null : (
            <div className="mt-3 grid min-w-0 gap-2">
              <p className="wrap-anywhere">
                {t("history.deleteSummary", {
                  mode: t(`history.modes.${deletion.target.configuration.mode}`),
                  date: dateFormat.format(new Date(deletion.target.finishedAt)),
                  result: resultTitle(deletion.target, t),
                })}
              </p>
              <Players game={deletion.target} username={username} />
            </div>
          )}
          {deletion.error ? (
            <p role="alert" className="mt-3 text-danger">
              {t(
                // Retrying a clear also removes games that finished after an unconfirmed attempt.
                clearing && deletion.error === "uncertain"
                  ? "history.deletionErrors.clearUncertain"
                  : `history.deletionErrors.${deletion.error}`,
              )}
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              variant="secondary"
              aria-disabled={deletion.pending}
              onClick={controller.cancelDeletion}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              aria-disabled={deletion.pending}
              onClick={() => {
                focusList.current = true;
                void controller.confirmDeletion();
              }}
            >
              {t(
                clearing
                  ? deletion.pending
                    ? "history.clearing"
                    : "history.clear"
                  : deletion.pending
                    ? "history.deleting"
                    : "history.delete",
              )}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </AccountFrame>
  );
}
