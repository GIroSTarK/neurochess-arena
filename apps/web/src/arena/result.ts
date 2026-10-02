import type { GameSnapshot } from "@neurochess/contracts";
import type { TFunction } from "i18next";

export function resultTitle(
  snapshot: Pick<GameSnapshot, "state" | "result">,
  t: TFunction,
): string {
  if (snapshot.state === "aborted") return t("game.stopped");
  if (snapshot.result === "1-0") return t("game.whiteWins");
  if (snapshot.result === "0-1") return t("game.blackWins");
  return t("game.draw");
}
