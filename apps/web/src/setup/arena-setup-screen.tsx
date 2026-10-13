import type { GameDetails } from "@neurochess/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { providerFailureMessage } from "../api/ai-messages";
import { ArenaHeader } from "../arena/arena-header";
import type { SavedCredentialChoices } from "../arena/setup/credential-source";
import { SeatSetup } from "../arena/setup/seat-setup";
import { AccountAccess } from "../auth/account-access";
import { PieceIcon } from "../board/piece-icon";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";
import { Button } from "../ui/button";
import { Select } from "../ui/select";

import {
  type SetupApi,
  SetupController,
  type SetupCredentials,
  type SetupEntry,
} from "./controller";
import { parameterErrors, setupConfiguration, type SetupIssue } from "./state";

/** The page owner supplies the credential lifetime and takes responsibility for the created game. */
export function ArenaSetupScreen({
  api,
  credentials,
  onCreated,
  onReturnToGame,
  savedCredentials,
  entry,
  onRetry,
}: {
  readonly api: SetupApi;
  readonly credentials: SetupCredentials;
  readonly onCreated: (game: GameDetails) => void;
  readonly onReturnToGame: (gameId: string) => void;
  readonly savedCredentials?: SavedCredentialChoices;
  readonly entry: SetupEntry;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [controller] = useState(() => new SetupController(api, credentials));
  const [initialEntry] = useState(entry);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(initialEntry), [controller, initialEntry]);
  useEffect(() => {
    if (savedCredentials?.phase === "ready") {
      controller.updateSavedCredentials(savedCredentials.credentials);
    }
  }, [controller, savedCredentials?.phase, savedCredentials?.credentials]);
  const ready = state.phase === "editing" && setupConfiguration(state) !== null;

  function issueMessage(issue: SetupIssue): string {
    switch (issue.code) {
      case "unavailable":
        return t("setup.unavailable");
      case "access":
        return t("setup.accessLost");
      case "key_format":
        return t("setup.keyInvalid");
      case "creation_uncertain":
        return t("setup.creationUncertain");
      default:
        return providerFailureMessage(issue, t);
    }
  }
  const seatMessage = (color: "white" | "black") => {
    if (state.mode === "ai_vs_human" && state.humanColor === color) return t("setup.humanSeat");
    const seat = state.seats[color];
    if (savedCredentials && seat.issue?.code === "provider_auth") {
      return t("credentials.unavailable");
    }
    if (seat.issue) return issueMessage(seat.issue);
    if (seat.discovery === "loading") return t("setup.loading");
    if (seat.modelId) return t("setup.selected");
    if (seat.discovery === "loaded") return t(seat.models.length ? "setup.loaded" : "setup.empty");
    return t("setup.discoveryHint");
  };
  const status = state.issue
    ? issueMessage(state.issue)
    : t(
        state.phase === "checking"
          ? "setup.checking"
          : state.phase === "creating"
            ? "setup.creating"
            : state.phase === "conflict"
              ? "setup.conflict"
              : state.phase === "handed-off"
                ? "setup.created"
                : ready
                  ? "setup.ready"
                  : "setup.notReady",
      );
  const announcement = `${status} ${t("players.white")}: ${seatMessage("white")} ${t("players.black")}: ${seatMessage("black")}`;

  return (
    <AppShell
      mainId="arena-setup"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      navigation={<AppNavigation page="arena" />}
      footer={t("setup.footer")}
      announcement={announcement}
    >
      <ArenaHeader
        title={t("setup.title")}
        description={t(state.mode === "ai_vs_ai" ? "setup.description" : "setup.humanDescription")}
      />
      <form
        className="mx-auto grid max-w-[1120px] min-w-0 gap-6 lg:chamfer-frame lg:p-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void controller.start().then((game) => {
            if (game) onCreated(game);
          });
        }}
      >
        <div className="grid gap-4 border-b border-divider pb-4 sm:grid-cols-2">
          <label className="grid gap-2 text-label">
            {t("setup.gameMode")}
            <Select
              value={state.mode}
              aria-disabled={state.phase !== "editing"}
              onChange={(event) =>
                controller.setMode(
                  event.target.value === "ai_vs_human" ? "ai_vs_human" : "ai_vs_ai",
                )
              }
            >
              <option value="ai_vs_ai">{t("setup.mode")}</option>
              <option value="ai_vs_human">{t("setup.humanMode")}</option>
            </Select>
          </label>
          {state.mode === "ai_vs_human" ? (
            <label className="grid gap-2 text-label">
              {t("setup.yourColor")}
              <Select
                value={state.humanColor}
                aria-disabled={state.phase !== "editing"}
                onChange={(event) =>
                  controller.setHumanColor(event.target.value === "black" ? "black" : "white")
                }
              >
                <option value="white">{t("players.white")}</option>
                <option value="black">{t("players.black")}</option>
              </Select>
            </label>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-6 lg:grid-cols-2 lg:gap-8">
          {(["white", "black"] as const).map((color) => {
            const seat = state.seats[color];
            if (state.mode === "ai_vs_human" && state.humanColor === color) {
              return (
                <fieldset
                  key={color}
                  className="grid min-w-0 content-start gap-6 rounded-panel border border-divider bg-surface p-4 md:p-6 lg:border-0 lg:bg-transparent"
                >
                  <legend className="sr-only">{t(`players.${color}`)}</legend>
                  <div
                    aria-hidden="true"
                    className="mb-2 flex w-full items-center gap-3 border-b border-divider pb-4 text-section font-semibold"
                  >
                    <PieceIcon color={color} kind="k" className="size-8 shrink-0" />
                    {t(`players.${color}`)}
                  </div>
                  <p>{t("setup.humanSeat")}</p>
                  <p className="text-body text-text-secondary">{t("setup.humanHint")}</p>
                </fieldset>
              );
            }
            return (
              <SeatSetup
                key={color}
                color={color}
                {...seat}
                disabled={state.phase !== "editing"}
                loading={seat.discovery === "loading"}
                loaded={seat.discovery === "loaded"}
                keyInvalid={
                  seat.issue?.code === "key_format" || seat.issue?.code === "provider_auth"
                }
                invalidParameters={parameterErrors(seat)}
                message={seatMessage(color)}
                error={seat.issue !== null}
                onProvider={(provider) => controller.setProvider(color, provider)}
                onKey={(value) => controller.setKey(color, value)}
                {...(savedCredentials ? { savedCredentials } : {})}
                onCredential={(value) => controller.setCredential(color, value)}
                onKeyBlur={() => controller.validateKey(color)}
                onDiscover={() => void controller.discover(color)}
                onModel={(model) => controller.setModel(color, model)}
                onParameter={(name, value) => controller.setParameter(color, name, value)}
              />
            );
          })}
        </div>
        <div className="grid gap-4 border-t border-divider pt-6 lg:mx-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="grid gap-2">
            <p className="text-body">{t("setup.standardPosition")}</p>
            <p id="setup-status" className="text-body text-text-secondary">
              {status}
            </p>
          </div>
          {state.phase === "conflict" && state.existingGameId ? (
            <Button
              variant="primary"
              onClick={() => {
                if (state.existingGameId) onReturnToGame(state.existingGameId);
              }}
            >
              {t("setup.returnToGame")}
            </Button>
          ) : state.phase === "unavailable" ? (
            <Button
              variant="primary"
              onClick={() => {
                if (state.issue?.code !== "creation_uncertain") onRetry();
                else void controller.checkExisting();
              }}
            >
              {t("setup.checkAgain")}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              aria-disabled={!ready}
              aria-describedby="setup-status"
            >
              {t(state.phase === "creating" ? "setup.creating" : "setup.start")}
            </Button>
          )}
        </div>
      </form>
    </AppShell>
  );
}
