import type { GameHistoryItem, GameHistoryPage } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiFailure } from "../api/failures";
import { AppNavigation } from "../app/AppNavigation";
import { AppShell } from "../app/AppShell";
import { AccountAccess } from "../auth/AccountAccess";
import { useRequiredAccount } from "../auth/context";
import { authHref } from "../auth/navigation";
import { Button } from "../ui/Button";

import { loadHistory } from "./client";

export function HistoryScreen({
  apiBaseUrl,
  sandboxEnabled,
}: {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
}) {
  const { t } = useTranslation();
  const { state } = useRequiredAccount();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <AppShell
      mainId="history-main"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      footer={t("auth.private")}
      announcement=""
      navigation={<AppNavigation page="history" sandboxEnabled={sandboxEnabled} />}
    >
      <section className="mx-auto my-8 grid max-w-5xl min-w-0 gap-6 md:my-12">
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-display text-title font-semibold outline-none"
        >
          {t("history.title")}
        </h1>
        {state.session ? (
          <HistoryList apiBaseUrl={apiBaseUrl} />
        ) : (
          <div className="grid gap-4 rounded-panel border border-divider bg-surface p-4">
            <p>{t("history.guest")}</p>
            <a
              href={authHref("sign-in", "/history")}
              className="flex min-h-11 items-center text-accent underline"
            >
              {t("history.signIn")}
            </a>
          </div>
        )}
      </section>
    </AppShell>
  );
}

interface PageRequest {
  cursor: string | null;
  previous: (string | null)[];
}
function HistoryList({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const { t } = useTranslation();
  const { controller } = useRequiredAccount();
  const [request, setRequest] = useState<PageRequest>({ cursor: null, previous: [] });
  const [response, setResponse] = useState<{
    request: PageRequest;
    page: GameHistoryPage | null;
  } | null>(null);
  const pending = response?.request !== request;
  const page = pending ? null : response.page;
  useEffect(() => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, controller.signal]);
    void loadHistory(apiBaseUrl, request.cursor, signal)
      .then((page) => {
        if (!signal.aborted) setResponse({ request, page });
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        if (error instanceof ApiFailure && error.code === "UNAUTHORIZED") controller.expired();
        else setResponse({ request, page: null });
      });
    return () => abort.abort();
  }, [apiBaseUrl, controller, request]);
  return (
    <>
      <p className="text-text-secondary">{t("history.description")}</p>
      <a href="/" className="flex min-h-11 w-fit items-center text-accent underline">
        {t("history.arena")}
      </a>
      {pending ? (
        <p role="status">{t("history.loading")}</p>
      ) : !page ? (
        <div className="grid justify-items-start gap-3">
          <p role="alert">{t("history.error")}</p>
          <Button variant="secondary" onClick={() => setRequest({ ...request })}>
            {t("history.retry")}
          </Button>
        </div>
      ) : page.games.length === 0 ? (
        <p>{t("history.empty")}</p>
      ) : (
        <ul className="grid min-w-0 gap-4" aria-label={t("history.title")}>
          {page.games.map((game) => (
            <HistoryRow key={game.gameId} game={game} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-3" aria-label={t("history.pagination")}>
        <Button
          variant="secondary"
          aria-disabled={pending || request.previous.length === 0}
          onClick={() =>
            setRequest({
              cursor: request.previous.at(-1) ?? null,
              previous: request.previous.slice(0, -1),
            })
          }
        >
          {t("history.newer")}
        </Button>
        <Button
          variant="secondary"
          aria-disabled={pending || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor) {
              setRequest({
                cursor: page.nextCursor,
                previous: [...request.previous, request.cursor],
              });
            }
          }}
        >
          {t("history.older")}
        </Button>
      </div>
    </>
  );
}

function HistoryRow({ game }: { readonly game: GameHistoryItem }) {
  const { t, i18n } = useTranslation();
  const result =
    game.state === "aborted"
      ? t("game.stopped")
      : t(
          game.result === "1-0"
            ? "game.whiteWins"
            : game.result === "0-1"
              ? "game.blackWins"
              : "game.draw",
        );
  return (
    <li className="grid min-w-0 gap-4 rounded-panel border border-divider bg-surface p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-center md:p-6">
      <div className="grid min-w-0 gap-3">
        <p className="text-label text-text-secondary">{t(`history.modes.${game.mode}`)}</p>
        <dl className="grid min-w-0 gap-2">
          {(["white", "black"] as const).map((color) => {
            const player = game.players[color];
            return (
              <div key={color} className="min-w-0">
                <dt className="text-caption text-text-secondary">{t(`players.${color}`)}</dt>
                <dd className="font-semibold wrap-anywhere">
                  {player.type === "human"
                    ? (player.username ?? t("setup.humanSeat"))
                    : player.modelId}
                </dd>
                {player.type === "ai" ? (
                  <dd className="text-caption text-text-secondary">
                    {t(`setup.providers.${player.provider}`)}
                  </dd>
                ) : null}
              </div>
            );
          })}
        </dl>
      </div>
      <div className="grid min-w-0 justify-items-start gap-2">
        <span className="rounded-control border border-control-border px-2 py-1 text-caption">
          {t(`history.states.${game.state}`)}
        </span>
        <p className="font-semibold">{result}</p>
        <p className="text-caption text-text-secondary">
          {t(`reasons.${game.terminationReason}`)} · {game.result}
        </p>
        <p className="text-caption text-text-secondary">
          {t("history.finished")}{" "}
          <time dateTime={game.finishedAt}>
            {new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(game.finishedAt))}
          </time>
        </p>
      </div>
      <a
        href={`/?game=${game.gameId}`}
        className="flex min-h-11 items-center justify-center rounded-control border border-control-border px-4 py-2 text-label font-semibold text-accent hover:bg-surface-raised"
      >
        {t("history.replay")}
      </a>
    </li>
  );
}
