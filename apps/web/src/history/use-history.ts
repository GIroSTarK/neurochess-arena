import type { GameHistoryEntry } from "@neurochess/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";

import { useRequiredAccount } from "../auth/context";

import type { HistoryActionData, HistoryIntent, HistoryRouteData } from "./route-data";

interface Pagination {
  readonly loader: HistoryRouteData | null;
  readonly fetched: HistoryRouteData | null | undefined;
  readonly visible: HistoryRouteData | null;
  readonly cursors: (string | undefined)[];
  readonly page: number;
  readonly target: number;
  readonly error: boolean;
  readonly epoch: number;
}

export function useHistory() {
  const loader = useLoaderData<HistoryRouteData | null>();
  const { state: account } = useRequiredAccount();
  const id = useId();
  const [pagination, setPagination] = useState<Pagination>(() => ({
    loader,
    fetched: undefined,
    visible: loader,
    cursors: [undefined],
    page: 0,
    target: 0,
    error: Boolean(loader?.data?.error),
    epoch: 0,
  }));
  const pages = useFetcher<HistoryRouteData | null>({ key: `${id}-${pagination.epoch}` });
  const mutation = useFetcher<HistoryActionData | null>();
  const { revalidate, state: revalidation } = useRevalidator();
  const [confirmation, setConfirmation] = useState<GameHistoryEntry | "all" | null>(null);
  const [acknowledged, setAcknowledged] = useState<HistoryActionData | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const busy = submitting || mutation.state !== "idle";
  const outcome = mutation.data?.generation === account.revision ? mutation.data.data : null;
  const success = outcome && "success" in outcome ? outcome.success : null;

  // Retain scoped references, never a copy of the private rows: identity and
  // deletion invalidation must also clear the last good page after a read error.
  if (loader !== pagination.loader) {
    const accepted = Boolean(loader?.data?.page);
    setPagination({
      ...pagination,
      loader,
      fetched: pages.data,
      epoch: pagination.epoch + 1,
      visible: accepted ? loader : pagination.visible,
      page: accepted ? 0 : pagination.page,
      target: 0,
      cursors: accepted ? [undefined] : pagination.cursors,
      error: Boolean(loader?.data?.error),
    });
  } else if (pages.state === "idle" && pages.data && pages.data !== pagination.fetched) {
    const accepted = Boolean(pages.data.data?.page);
    setPagination({
      ...pagination,
      fetched: pages.data,
      visible: accepted ? pages.data : pagination.visible,
      page: accepted ? pagination.target : pagination.page,
      cursors: accepted ? pagination.cursors.slice(0, pagination.target + 1) : pagination.cursors,
      error: Boolean(pages.data.data?.error),
    });
  }
  if (success && mutation.data && mutation.data !== acknowledged) {
    setAcknowledged(mutation.data);
    setConfirmation(null);
    setPagination({
      loader,
      fetched: undefined,
      visible: null,
      cursors: [undefined],
      page: 0,
      target: 0,
      error: false,
      epoch: pagination.epoch + 1,
    });
  }

  useEffect(() => {
    if (acknowledged) void revalidate();
  }, [acknowledged, revalidate]);

  const resetPages = pages.reset;
  const resetMutation = mutation.reset;
  useEffect(() => () => resetPages(), [resetPages]);
  useEffect(() => () => resetMutation(), [resetMutation]);

  const result =
    pagination.visible?.generation === account.revision
      ? (pagination.visible.data?.page ?? null)
      : null;
  const loading = pages.state !== "idle" || revalidation !== "idle";
  const deletionError =
    attempted && !busy && !success
      ? outcome && "error" in outcome
        ? outcome.error
        : "unconfirmed"
      : null;

  function load(page: number, cursor = pagination.cursors[page]) {
    if (busy || pending.current) return;
    resetMutation();
    setAttempted(false);
    const cursors = [...pagination.cursors];
    cursors[page] = cursor;
    setPagination({
      ...pagination,
      target: page,
      cursors,
      error: false,
    });
    void pages.load("/history" + (cursor ? "?" + new URLSearchParams({ cursor }).toString() : ""));
  }
  function confirm(value: GameHistoryEntry | "all") {
    if (busy || pending.current || loading) return;
    resetMutation();
    setAttempted(false);
    setConfirmation(value);
  }
  function cancelDeletion() {
    if (busy || pending.current) return;
    setConfirmation(null);
    setAttempted(false);
    resetMutation();
  }
  function deleteConfirmed() {
    if (!confirmation || busy || pending.current || !account.session) return;
    const input: HistoryIntent = {
      ...(confirmation === "all"
        ? { intent: "clear-history" }
        : { intent: "delete-game", gameId: confirmation.gameId }),
      confirm: "true",
      expectedAccount: account.session.user.id,
    };
    pending.current = true;
    setSubmitting(true);
    resetPages();
    resetMutation();
    setAttempted(true);
    void mutation.submit(input, { method: "post", action: "/history" }).finally(() => {
      pending.current = false;
      setSubmitting(false);
    });
  }
  return {
    Form: mutation.Form,
    result,
    page: pagination.page,
    phase: loading ? "loading" : pagination.error ? "error" : "ready",
    confirmation,
    deleting: busy,
    deletionError,
    success,
    confirmClear: () => confirm("all"),
    confirmGame: confirm,
    cancelDeletion,
    deleteConfirmed,
    reload: () => load(0),
    retry: () => load(pagination.target),
    older: () => {
      if (!loading && result?.nextCursor) load(pagination.page + 1, result.nextCursor);
    },
    newer: () => {
      if (!loading && pagination.page > 0) load(pagination.page - 1);
    },
  };
}
