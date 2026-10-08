import type { ChessSnapshot, DomainResult } from "@neurochess/chess";
import type { ChessColor } from "@neurochess/contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArenaDetails } from "../arena/arena-details";
import { ArenaHeader } from "../arena/arena-header";
import { ArenaLayout } from "../arena/arena-layout";
import { BoardTools } from "../arena/board-tools";
import { LifecycleControls } from "../arena/panels/lifecycle-controls";
import { MoveHistory } from "../arena/panels/move-history";
import type { PlayerSummaryData } from "../arena/panels/player-summary";
import { ReplayControls } from "../arena/panels/replay-controls";
import { resultReason, resultScore } from "../arena/result";
import { Chessboard } from "../board/chessboard";
import { isTerminal } from "../gameplay/snapshot";
import { standardPositionPreview } from "../position/preview";
import { replayView } from "../position/replay";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";
import { Select } from "../ui/select";

import { ReferencePanels } from "./reference-panels";
import { createReferenceGame, type ReferenceScenario, referenceScenarios } from "./scenarios";

export function ArenaReferenceScreen() {
  const { t } = useTranslation();
  const scenarios = referenceScenarios(t);
  const [scenarioId, setScenarioId] = useState<ReferenceScenario["id"]>("humanHuman");
  const [replay, setReplay] = useState(false);
  const scenario = scenarios.find((scenario) => scenario.id === scenarioId);
  if (!scenario) return null;

  return (
    <AppShell
      mainId="arena-reference"
      skipLabel={t("app.skipLink")}
      context={t("reference.badge")}
      navigation={<AppNavigation page="reference" />}
      footer={t("reference.description")}
      announcement=""
    >
      <section
        className="mx-auto mt-6 max-w-[1120px] rounded-panel border border-warning bg-surface p-4"
        aria-label={t("reference.badge")}
      >
        <p className="text-label font-semibold text-warning">{t("reference.badge")}</p>
        <p className="mt-2 text-body text-text-secondary">{t("reference.description")}</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="grid min-w-0 gap-2 text-label">
            {t("reference.scenario")}
            <Select
              value={scenario.id}
              onChange={(event) => {
                const selected = scenarios.find((scenario) => scenario.id === event.target.value);
                if (selected) setScenarioId(selected.id);
              }}
            >
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid min-w-0 gap-2 text-label">
            {t("reference.state")}
            <Select
              value={replay ? "replay" : "live"}
              onChange={(event) => setReplay(event.target.value === "replay")}
            >
              <option value="live">{t("reference.live")}</option>
              <option value="replay">{t("reference.replay")}</option>
            </Select>
          </label>
        </div>
      </section>
      <ReferenceMatch
        key={`${scenario.id}-${replay ? "replay" : "live"}`}
        scenario={scenario}
        replay={replay}
      />
    </AppShell>
  );
}

function ReferenceMatch({
  scenario,
  replay,
}: {
  readonly scenario: ReferenceScenario;
  readonly replay: boolean;
}) {
  const { t } = useTranslation();
  const helpId = useId();
  const [game] = useState(() => createReferenceGame(replay));
  const [snapshot, setSnapshot] = useState(() => game.snapshot());
  const [ply, setPly] = useState(snapshot.moves.length);
  const [orientation, setOrientation] = useState<ChessColor>(scenario.human ?? "white");
  const terminal = isTerminal(snapshot);
  const paused = snapshot.state === "paused";
  const visibleMoves = terminal ? snapshot.moves.slice(0, ply) : snapshot.moves;
  const view = terminal
    ? replayView({ initialFen: standardPositionPreview.fen, snapshot }, ply)
    : { ...snapshot, lastMove: snapshot.moves.at(-1)?.uci };
  const hasModels = scenario.players.white.kind === "ai" || scenario.players.black.kind === "ai";

  function apply(result: DomainResult<ChessSnapshot>) {
    if (!result.ok) return;
    setSnapshot(result.value);
    setPly(result.value.moves.length);
  }

  function player(color: ChessColor): PlayerSummaryData {
    const identity = scenario.players[color];
    const isTurn = !terminal && !paused && snapshot.turn === color;
    const label = terminal
      ? t("players.inspecting")
      : paused
        ? t("players.paused")
        : isTurn
          ? identity.kind === "ai"
            ? t("players.thinking")
            : t("players.toMove")
          : t("players.waiting");
    return {
      identity,
      activity: {
        label,
        variants: [
          t("players.inspecting"),
          t("players.paused"),
          t("players.toMove"),
          t("players.waiting"),
          t("players.thinking"),
        ],
        isTurn,
      },
    };
  }

  if (!view) return null;
  return (
    <>
      <ArenaHeader
        title={snapshot.terminationReason ? resultReason(snapshot, t) : scenario.label}
        description={
          terminal
            ? scenario.label
            : t(paused ? "game.pausedTurn" : "game.turn", { color: t(`players.${snapshot.turn}`) })
        }
        trailing={<span className="text-label text-warning">{t("reference.badge")}</span>}
        score={
          terminal ? (
            <span
              className="font-display text-title"
              aria-label={t("game.score", { score: snapshot.result })}
            >
              {resultScore(snapshot.result)}
            </span>
          ) : undefined
        }
      />
      <ArenaLayout
        players={{ white: player("white"), black: player("black") }}
        playAreaLabel={t("arena.playArea")}
        detailsLabel={t("arena.gameDetails")}
        board={
          <>
            <Chessboard
              view={view}
              canMove={false}
              interactionEpoch={`${snapshot.state}-${ply}`}
              orientation={orientation}
              describedBy={helpId}
              onMove={() => undefined}
            />
            {terminal ? (
              <>
                <ReplayControls
                  available
                  loading={false}
                  count={snapshot.moves.length}
                  ply={ply}
                  notice={null}
                  onRetry={null}
                  onSelect={(next) => {
                    if (Number.isInteger(next) && next >= 0 && next <= snapshot.moves.length) {
                      setPly(next);
                    }
                  }}
                />
                <BoardTools
                  orientation={orientation}
                  onFlip={() => setOrientation((color) => (color === "white" ? "black" : "white"))}
                  helpId={helpId}
                />
              </>
            ) : (
              <LifecycleControls
                paused={paused}
                disabled={false}
                epoch={snapshot.state}
                onTogglePause={
                  scenario.canPause ? () => apply(paused ? game.resume() : game.pause()) : undefined
                }
                onAbort={() => apply(game.abort())}
                abortDescription={t("reference.abortDescription")}
                resignations={
                  scenario.human
                    ? [
                        {
                          color: scenario.human,
                          onResign: () => {
                            if (scenario.human) apply(game.resignHuman(scenario.human));
                          },
                        },
                      ]
                    : []
                }
                boardTools={{
                  orientation,
                  helpId,
                  onFlip: () => setOrientation((color) => (color === "white" ? "black" : "white")),
                }}
              />
            )}
          </>
        }
        details={
          <ArenaDetails
            commentary={
              hasModels ? (
                <ReferencePanels scenario={scenario} moves={visibleMoves} kind="commentary" />
              ) : undefined
            }
            telemetry={
              hasModels ? (
                <ReferencePanels scenario={scenario} moves={visibleMoves} kind="telemetry" />
              ) : undefined
            }
            moves={
              <MoveHistory
                showHeading={!hasModels}
                moves={snapshot.moves}
                selectedPly={terminal ? ply : undefined}
                onSelect={terminal ? setPly : undefined}
              />
            }
            analysis={
              hasModels ? (
                <section aria-label={t("reference.analysis")}>
                  <p className="text-text-secondary">{t("reference.analysisHint")}</p>
                </section>
              ) : undefined
            }
            events={
              hasModels ? (
                <section aria-label={t("reference.events")}>
                  <ol className="space-y-3 text-label text-text-secondary">
                    {visibleMoves.map((move) => (
                      <li key={move.ply}>
                        {t("reference.event", { ply: move.ply, move: move.san })}
                      </li>
                    ))}
                  </ol>
                  {visibleMoves.length === 0 ? <p>{t("reference.noEvents")}</p> : null}
                </section>
              ) : undefined
            }
          >
            <p className="shrink-0 border-t border-divider pt-4 text-body text-text-secondary">
              {paused
                ? t("reference.pausedHint")
                : terminal
                  ? t("replay.hint")
                  : t(
                      scenario.id === "humanHuman"
                        ? "reference.humanHint"
                        : scenario.human
                          ? "reference.mixedHint"
                          : "reference.aiHint",
                    )}
            </p>
          </ArenaDetails>
        }
      />
    </>
  );
}
