import {
  type AiGameConfiguration,
  aiRuntimeHeader,
  type ChessColor,
  type CreateAiGameRequest,
  type GameSnapshot,
  type ProviderDescriptor,
  type SessionCredential,
} from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { createAiSetupApi, createAiTurnApi } from "../api/ai";
import { ApiFailure, createSandboxApi } from "../api/client";
import { DocumentMetadata } from "../app/DocumentMetadata";
import { isAccessCode } from "../game/failures";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";

import { AiSeat } from "./AiSeat";
import { GamePreview } from "./GamePreview";
import { useAiSeat } from "./useAiSeat";

export function AiSetup({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const { t } = useTranslation();
  const [api] = useState(() => createAiSetupApi(apiBaseUrl));
  const [turnApi] = useState(() => createAiTurnApi(apiBaseUrl));
  const [common] = useState(() =>
    createSandboxApi(apiBaseUrl, {
      onResponse: (response) => turnApi.acknowledgeRuntime?.(response.headers.get(aiRuntimeHeader)),
    }),
  );
  const white = useAiSeat(api);
  const black = useAiSeat(api);
  const opponent = useAiSeat(api);
  const [mode, setMode] = useState<"ai_vs_ai" | "ai_vs_human">("ai_vs_ai");
  const [humanColor, setHumanColor] = useState<ChessColor>("white");
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<"service" | "create" | "access" | null>(null);
  const [existing, setExisting] = useState<GameSnapshot | null>(null);
  const existingAi = useRef(false);
  const [preview, setPreview] = useState<{
    snapshot: GameSnapshot;
    recovered: boolean;
    configuration: AiGameConfiguration | null;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const startAbort = useRef<AbortController | null>(null);
  const playbackCredentials = useRef<Partial<Record<ChessColor, SessionCredential>>>({});
  const [, credentialsChanged] = useState(0);
  function clearCredentials() {
    for (const value of Object.values(playbackCredentials.current)) value.apiKey = "";
    playbackCredentials.current = {};
    credentialsChanged((value) => value + 1);
  }
  useEffect(() => {
    const clear = () => {
      startAbort.current?.abort();
      startAbort.current = null;
      setStarting(false);
      clearCredentials();
    };
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      for (const value of Object.values(playbackCredentials.current)) value.apiKey = "";
      playbackCredentials.current = {};
    };
  }, []);
  useEffect(() => {
    if (preview) return;
    const returned = (event: PageTransitionEvent) => {
      if (event.persisted) setReload((value) => value + 1);
    };
    window.addEventListener("pageshow", returned);
    return () => window.removeEventListener("pageshow", returned);
  }, [preview]);
  useEffect(() => () => startAbort.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        await common.bootstrap(abort.signal);
        const [registered, aiGame, sandboxGame] = await Promise.all([
          api.providers(abort.signal),
          api.unfinished(abort.signal),
          common.unfinished(abort.signal).catch((failure: unknown) => {
            if (failure instanceof ApiFailure && failure.code === "NOT_FOUND") return null;
            throw failure;
          }),
        ]);
        if (abort.signal.aborted) return;
        setProviders(registered);
        setExisting(aiGame ?? sandboxGame);
        existingAi.current = aiGame !== null;
        setError(null);
      } catch {
        if (!abort.signal.aborted) setError("service");
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [api, common, reload]);
  const ready =
    !loading &&
    !error &&
    providers.length > 0 &&
    !existing &&
    (mode === "ai_vs_ai" ? white.ready && black.ready : opponent.ready);
  async function start() {
    if (!ready || startAbort.current) return;
    const fresh = (mode === "ai_vs_ai" ? [white, black] : [opponent]).map((seat) =>
      seat.ensureFresh(),
    );
    if (fresh.some((value) => !value)) return;
    const configuration: CreateAiGameRequest | null =
      mode === "ai_vs_ai"
        ? white.selection &&
          black.selection && { mode, white: white.selection, black: black.selection }
        : opponent.selection && { mode, humanColor, ai: opponent.selection };
    if (!configuration) return;
    const abort = new AbortController();
    startAbort.current = abort;
    setStarting(true);
    setError(null);
    try {
      const snapshot = await api.create(configuration, abort.signal);
      if (!abort.signal.aborted) {
        playbackCredentials.current =
          configuration.mode === "ai_vs_ai"
            ? {
                white: { provider: configuration.white.provider, apiKey: white.key },
                black: { provider: configuration.black.provider, apiKey: black.key },
              }
            : {
                [configuration.humanColor === "white" ? "black" : "white"]: {
                  provider: configuration.ai.provider,
                  apiKey: opponent.key,
                },
              };
        setPreview({ snapshot, recovered: false, configuration });
        for (const seat of [white, black, opponent]) seat.changeKey("");
      }
    } catch (failure: unknown) {
      if (abort.signal.aborted) return;
      if (
        failure instanceof ApiFailure &&
        failure.code === "GAME_CONFLICT" &&
        failure.currentSnapshot
      ) {
        setExisting(failure.currentSnapshot);
        // A competing creator may have occupied the slot; rediscovery identifies its mode.
        setLoading(true);
        setReload((value) => value + 1);
      } else {
        setError(
          failure instanceof ApiFailure &&
            (failure.code === "UNAUTHORIZED" || failure.code === "FORBIDDEN")
            ? "access"
            : "create",
        );
      }
    } finally {
      if (startAbort.current === abort) startAbort.current = null;
      if (!abort.signal.aborted) setStarting(false);
    }
  }
  function retry() {
    setLoading(true);
    setError(null);
    // Bootstrap can replace an expired guest, whose catalog references cannot be reused.
    for (const seat of [white, black, opponent]) seat.resetDiscovery();
    setReload((value) => value + 1);
  }
  async function returnGame() {
    if (!existing || startAbort.current || loading || error) return;
    const abort = new AbortController();
    startAbort.current = abort;
    setStarting(true);
    setError(null);
    clearCredentials();
    for (const seat of [white, black, opponent]) seat.changeKey("");
    try {
      const restored = existingAi.current ? await api.game(existing.gameId, abort.signal) : null;
      if (!abort.signal.aborted) {
        setPreview({
          snapshot: restored?.snapshot ?? existing,
          configuration: restored?.configuration ?? null,
          recovered: true,
        });
      }
    } catch (failure: unknown) {
      if (!abort.signal.aborted) {
        const access = failure instanceof ApiFailure && isAccessCode(failure.code);
        if (access) {
          setExisting(null);
          existingAi.current = false;
        }
        setError(access ? "access" : "service");
      }
    } finally {
      if (startAbort.current === abort) startAbort.current = null;
      if (!abort.signal.aborted) setStarting(false);
    }
  }
  const match = preview?.configuration ?? null;
  const liveCopy = match?.mode === "ai_vs_human" ? "humanPlay" : "playback";
  return (
    <div className="mx-auto w-[min(1280px,calc(100%_-_2rem))] pb-[max(2rem,env(safe-area-inset-bottom))] md:w-[min(1280px,calc(100%_-_3rem))] lg:w-[min(1280px,calc(100%_-_4rem))]">
      <DocumentMetadata arena matchMode={match?.mode} />
      <a
        className="sr-only top-3 left-4 z-20 rounded-control bg-accent p-3 text-on-accent focus:not-sr-only focus:fixed"
        href="#setup"
      >
        {t("setup.skip")}
      </a>
      <header className="flex min-h-22 flex-wrap items-center justify-between gap-4 border-b border-divider py-4">
        <p className="font-display text-body font-semibold tracking-[0.035em] uppercase">
          {t("app.brand")} <span className="text-accent">{t("app.arena")}</span>
        </p>
        <a
          href="/sandbox"
          className="inline-flex min-h-target items-center text-label text-text-secondary"
        >
          {t("sandbox.title")}
        </a>
      </header>
      <main id="setup" tabIndex={-1}>
        <div className="py-8">
          <p className="mb-3 text-label font-semibold text-accent">{t("setup.eyebrow")}</p>
          <h1 className="font-display text-title font-medium md:text-display">
            {t(match ? `${liveCopy}.title` : "setup.title")}
          </h1>
          <p className="mt-3 max-w-3xl text-text-secondary">
            {t(match ? `${liveCopy}.description` : "setup.description")}
          </p>
        </div>
        {preview ? (
          <GamePreview
            key={preview.snapshot.gameId}
            api={common}
            turnApi={turnApi}
            credential={(color) => playbackCredentials.current[color] ?? null}
            onCredential={(color, value) => {
              playbackCredentials.current[color] = value;
              credentialsChanged((revision) => revision + 1);
            }}
            match={match}
            initial={preview.snapshot}
            recovered={preview.recovered}
            onSetup={() => {
              setPreview(null);
              clearCredentials();
              setExisting(null);
              retry();
            }}
          />
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <fieldset className="mb-6" aria-disabled={starting}>
              <legend className="mb-3 text-label font-semibold">{t("setup.mode")}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["ai_vs_ai", "ai_vs_human"] as const).map((value) => (
                  <label
                    key={value}
                    className={cx(
                      "flex min-h-target cursor-pointer items-start gap-3 rounded-control border p-4",
                      mode === value
                        ? "border-accent bg-surface-raised"
                        : "border-control-border bg-surface",
                    )}
                  >
                    <input
                      className="mt-1 size-4 shrink-0 accent-accent"
                      type="radio"
                      name="mode"
                      value={value}
                      checked={mode === value}
                      onChange={() => {
                        if (starting || mode === value) return;
                        for (const seat of [white, black, opponent]) seat.resetNumericValidity();
                        setMode(value);
                      }}
                    />
                    <span>
                      <strong className="block text-body">{t(`setup.modes.${value}`)}</strong>
                      <span className="mt-1 block text-label text-text-secondary">
                        {t(`setup.modeHints.${value}`)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {mode === "ai_vs_human" ? (
              <fieldset className="mb-6 flex flex-wrap gap-4">
                <legend className="mb-3 text-label font-semibold">{t("setup.humanColor")}</legend>
                {(["white", "black"] as const).map((color) => (
                  <label
                    key={color}
                    className="flex min-h-target items-center gap-3 rounded-control border border-control-border bg-surface px-4"
                  >
                    <input
                      type="radio"
                      name="human-color"
                      checked={humanColor === color}
                      onChange={() => {
                        if (!starting) setHumanColor(color);
                      }}
                      className="size-4 accent-accent"
                    />
                    {t(`players.${color}`)}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {loading ? (
              <p role="status" className="mb-4 text-text-secondary">
                {t("setup.loadingProviders")}
              </p>
            ) : null}
            {!loading && !error && providers.length === 0 ? (
              <p role="status" className="mb-4 text-warning">
                {t("setup.noProviders")}
              </p>
            ) : null}
            {error ? (
              <div role="alert" className="mb-6 space-y-3 rounded-panel border border-warning p-4">
                <p>{t(`setup.errors.${error}`)}</p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (error === "access") setExisting(null);
                    retry();
                  }}
                >
                  {t(error === "access" ? "setup.returnSetup" : "setup.retry")}
                </Button>
              </div>
            ) : null}
            {existing && error !== "access" ? (
              <div className="mb-6 space-y-3 rounded-panel border border-warning p-4" role="status">
                <p>{t("setup.existing")}</p>
                <Button
                  variant="primary"
                  aria-disabled={starting || loading || error !== null}
                  onClick={() => {
                    void returnGame();
                  }}
                >
                  {t("setup.returnGame")}
                </Button>
              </div>
            ) : null}
            <div
              className={cx(
                "grid min-w-0 gap-6",
                mode === "ai_vs_ai" ? "lg:grid-cols-2" : "max-w-2xl",
              )}
            >
              {mode === "ai_vs_ai" ? (
                <>
                  <AiSeat
                    key="white"
                    color="white"
                    seat={white}
                    providers={providers}
                    disabled={starting || loading}
                  />
                  <AiSeat
                    key="black"
                    color="black"
                    seat={black}
                    providers={providers}
                    disabled={starting || loading}
                  />
                </>
              ) : (
                <AiSeat
                  key="opponent"
                  color={humanColor === "white" ? "black" : "white"}
                  seat={opponent}
                  providers={providers}
                  disabled={starting || loading}
                />
              )}
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-panel border border-divider bg-surface p-4 md:p-6">
              <div className="max-w-3xl text-label text-text-secondary">
                <p>{t("setup.privacy")}</p>
                <p id="start-hint" className="mt-2">
                  {t(ready ? "setup.startReady" : "setup.startHint")}
                </p>
              </div>
              <Button
                variant="primary"
                type="submit"
                aria-disabled={!ready || starting}
                aria-describedby="start-hint"
                className="max-sm:w-full"
              >
                {t(starting ? "setup.starting" : "setup.start")}
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
