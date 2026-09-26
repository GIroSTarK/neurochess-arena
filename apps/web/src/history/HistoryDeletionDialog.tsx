import type { GameHistoryItem } from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiFailure } from "../api/failures";
import { useRequiredAccount } from "../auth/context";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import { clearHistory, deleteGame } from "./client";

export type DeletionNotice = "deleted" | "cleared" | "unavailable";

export function HistoryDeletionDialog({
  apiBaseUrl,
  target,
  onCancel,
  onDeleted,
}: {
  readonly apiBaseUrl: string;
  readonly target: GameHistoryItem | "all";
  readonly onCancel: () => void;
  readonly onDeleted: (notice: DeletionNotice) => void;
}) {
  const { t, i18n } = useTranslation();
  const { controller } = useRequiredAccount();
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<"failed" | "unfinished" | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function confirm() {
    if (request.current) return;
    const abort = new AbortController();
    request.current = abort;
    const signal = AbortSignal.any([abort.signal, controller.signal]);
    setBusy(true);
    setIssue(null);
    try {
      if (target === "all") await clearHistory(apiBaseUrl, signal);
      else await deleteGame(apiBaseUrl, target.gameId, signal);
      if (!signal.aborted) onDeleted(target === "all" ? "cleared" : "deleted");
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiFailure && error.code === "UNAUTHORIZED") controller.expired();
      else if (target !== "all" && error instanceof ApiFailure && error.code === "NOT_FOUND") {
        onDeleted("unavailable");
      } else {
        setIssue(
          error instanceof ApiFailure && error.code === "INVALID_GAME_STATE"
            ? "unfinished"
            : "failed",
        );
      }
    } finally {
      request.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog
      title={t(target === "all" ? "history.deletion.clearTitle" : "history.deletion.gameTitle")}
      description={t(
        target === "all" ? "history.deletion.clearDescription" : "history.deletion.gameDescription",
      )}
      onCancel={() => {
        if (!request.current) onCancel();
      }}
    >
      {target !== "all" ? (
        <div className="mt-4 grid min-w-0 gap-2 text-body wrap-anywhere">
          {(["white", "black"] as const).map((color) => {
            const player = target.players[color];
            return (
              <p key={color}>
                {t(`players.${color}`)}:{" "}
                {player.type === "human"
                  ? (player.username ?? t("setup.humanSeat"))
                  : player.modelId}
              </p>
            );
          })}
          <p>
            {t("history.finished")}{" "}
            <time dateTime={target.finishedAt}>
              {new Intl.DateTimeFormat(i18n.resolvedLanguage ?? "en", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(target.finishedAt))}
            </time>
          </p>
        </div>
      ) : null}
      {issue ? (
        <p role="alert" className="mt-4 text-danger">
          {t(`history.deletion.${issue}`)}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="secondary" aria-disabled={busy} onClick={onCancel}>
          {t("history.deletion.cancel")}
        </Button>
        <Button variant="danger" aria-disabled={busy} onClick={() => void confirm()}>
          {t(target === "all" ? "history.deletion.clear" : "history.deletion.game")}
        </Button>
      </div>
      {busy ? (
        <p role="status" className="mt-3">
          {t("history.deletion.pending")}
        </p>
      ) : null}
    </Dialog>
  );
}
