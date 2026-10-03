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
  const listHeading = useRef<HTMLHeadingElement>(null);
  const successId = useId();
  useEffect(() => controller.connect(), [controller]);
  useEffect(() => {
    if (state.success) listHeading.current?.focus();
  }, [state.success]);
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
          onClick={controller.confirmClear}
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
          <Button variant="secondary" onClick={controller.retry}>
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
                <a
                  href={"/?game=" + game.gameId}
                  className="inline-flex min-h-target items-center text-accent underline"
                  aria-label={t("history.replayLabel", { date, result: resultTitle(game, t) })}
                >
                  {t("history.replay")}
                </a>
                <Button
                  variant="secondary"
                  aria-label={t("history.deleteLabel", {
                    date,
                    result: resultTitle(game, t),
                    gameReference,
                  })}
                  aria-disabled={state.phase === "loading" || state.deleting}
                  onClick={() => controller.confirmGame(game)}
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
              onClick={controller.newer}
            >
              {t("history.newer")}
            </Button>
            <Button
              variant="secondary"
              aria-disabled={
                state.phase === "loading" || state.deleting || !state.result.nextCursor
              }
              onClick={controller.older}
            >
              {t("history.older")}
            </Button>
            <Button
              variant="quiet"
              aria-disabled={state.phase === "loading" || state.deleting}
              onClick={controller.reload}
            >
              {t("history.refresh")}
            </Button>
          </div>
        </div>
      ) : null}
      {state.confirmation ? (
        <Dialog
          title={t(state.confirmation === "all" ? "history.clearTitle" : "history.deleteTitle")}
          description={t(state.confirmation === "all" ? "history.clearHint" : "history.deleteHint")}
          onCancel={controller.cancelDeletion}
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
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              variant="secondary"
              aria-disabled={state.deleting}
              onClick={controller.cancelDeletion}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              aria-disabled={state.deleting}
              onClick={() => void controller.deleteConfirmed()}
            >
              {t(
                state.deleting
                  ? "account.working"
                  : state.confirmation === "all"
                    ? "history.clear"
                    : "history.delete",
              )}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </AccountFrame>
  );
}
