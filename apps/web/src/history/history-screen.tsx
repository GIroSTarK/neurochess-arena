import type { GameHistoryEntry } from "@neurochess/contracts";
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

import { resultTitle } from "../arena/result";
import { AccountFrame } from "../auth/account-frame";
import { authHref, gameHref } from "../routing/route-urls";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { TextLink } from "../ui/text-link";

import { useHistory } from "./use-history";

function GameParticipants({
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

export function GuestHistory() {
  const { t } = useTranslation();
  return (
    <AccountFrame title={t("history.title")} page="history">
      <p>{t("history.guest")}</p>
      <TextLink to={authHref("sign-in", "/history")}>{t("account.signIn")}</TextLink>
      <TextLink to="/">{t("history.arena")}</TextLink>
    </AccountFrame>
  );
}

export function HistoryScreen({ username }: { readonly username: string }) {
  const { t, i18n } = useTranslation();
  const state = useHistory();
  const listHeading = useRef<HTMLHeadingElement>(null);
  const successId = useId();
  const confirmationFormId = useId();
  useEffect(() => {
    if (state.success) listHeading.current?.focus();
  }, [state.success]);
  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <AccountFrame title={t("history.title")} page="history">
      <p className="text-body text-text-secondary">{t("history.description")}</p>
      <TextLink to="/">{t("history.arena")}</TextLink>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          ref={listHeading}
          tabIndex={-1}
          aria-describedby={successId}
          className="text-section font-semibold"
        >
          {t("history.list")}
        </h2>
        <Button
          variant="secondary"
          aria-disabled={
            state.phase === "loading" ||
            state.deleting ||
            !state.result ||
            (state.page === 0 && state.result.games.length === 0)
          }
          onClick={state.confirmClear}
        >
          {t("history.clear")}
        </Button>
      </div>
      <p
        id={successId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={state.success ? undefined : "sr-only"}
      >
        {state.success ? t(`history.deleted.${state.success}`) : ""}
      </p>
      {state.phase === "loading" ? <p role="status">{t("history.loading")}</p> : null}
      {state.phase === "error" ? (
        <div className="grid gap-3">
          <p role="alert">{t("history.loadError")}</p>
          <Button variant="secondary" onClick={state.retry}>
            {t("history.retry")}
          </Button>
        </div>
      ) : null}
      {state.result?.games.length === 0 ? <p>{t("history.empty")}</p> : null}
      <ul className="grid min-w-0 gap-4" aria-label={t("history.list")}>
        {state.result?.games.map((game) => {
          const date = dateFormat.format(new Date(game.finishedAt));
          const gameReference = t("history.gameReference", { gameId: game.gameId });
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
              <GameParticipants game={game} username={username} />
              <p className="text-label wrap-anywhere text-text-secondary">{gameReference}</p>
              <p>
                {t("game.resultWithScore", {
                  result: resultTitle(game, t),
                  reason: t(`reasons.${game.terminationReason}`),
                  score: game.result,
                })}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TextLink
                  to={gameHref("arena", game.gameId)}
                  aria-label={t("history.replayLabel", { date, result: resultTitle(game, t) })}
                >
                  {t("history.replay")}
                </TextLink>
                <Button
                  variant="secondary"
                  aria-label={t("history.deleteLabel", {
                    date,
                    result: resultTitle(game, t),
                    gameReference,
                  })}
                  aria-disabled={state.phase === "loading" || state.deleting}
                  onClick={() => state.confirmGame(game)}
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
              aria-disabled={state.phase === "loading" || state.deleting || state.page === 0}
              onClick={state.newer}
            >
              {t("history.newer")}
            </Button>
            <Button
              variant="secondary"
              aria-disabled={
                state.phase === "loading" || state.deleting || !state.result.nextCursor
              }
              onClick={state.older}
            >
              {t("history.older")}
            </Button>
            <Button
              variant="quiet"
              aria-disabled={state.phase === "loading" || state.deleting}
              onClick={state.reload}
            >
              {t("history.refresh")}
            </Button>
          </div>
        </div>
      ) : null}
      {state.confirmation ? (
        <ConfirmDialog
          title={t(state.confirmation === "all" ? "history.clearTitle" : "history.deleteTitle")}
          description={t(state.confirmation === "all" ? "history.clearHint" : "history.deleteHint")}
          onCancel={state.cancelDeletion}
          cancelLabel={t("actions.cancel")}
          confirmLabel={t(
            state.deleting
              ? "account.working"
              : state.confirmation === "all"
                ? "history.clear"
                : "history.delete",
          )}
          cancelDisabled={state.deleting}
          confirmDisabled={state.deleting}
          confirmForm={confirmationFormId}
        >
          {state.confirmation !== "all" ? (
            <div className="mt-3 grid gap-3 wrap-anywhere">
              <p>
                {t("history.gameSummary", {
                  date: dateFormat.format(new Date(state.confirmation.finishedAt)),
                  result: resultTitle(state.confirmation, t),
                })}
              </p>
              <p className="text-label text-text-secondary">
                {t(`history.modes.${state.confirmation.configuration.mode}`)}
              </p>
              <GameParticipants game={state.confirmation} username={username} />
              <p className="text-label text-text-secondary">
                {t("history.gameReference", { gameId: state.confirmation.gameId })}
              </p>
            </div>
          ) : null}
          {state.deletionError ? (
            <p role="alert" className="mt-3 text-danger">
              {t(`history.deletionErrors.${state.deletionError}`)}
            </p>
          ) : null}
          <state.Form
            id={confirmationFormId}
            method="post"
            action="/history"
            onSubmit={(event) => {
              event.preventDefault();
              state.deleteConfirmed();
            }}
          />
        </ConfirmDialog>
      ) : null}
    </AccountFrame>
  );
}
