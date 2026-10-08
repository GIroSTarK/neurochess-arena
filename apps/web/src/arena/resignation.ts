import type { ChessColor } from "@neurochess/contracts";
import type { TFunction } from "i18next";

export function resignationConfirmation(color: ChessColor, t: TFunction) {
  return {
    title: t("lifecycle.resignTitle", { color: t(`players.${color}`) }),
    description: t("lifecycle.resignDescription", {
      winner: t(color === "white" ? "players.black" : "players.white"),
    }),
    confirmLabel: t("lifecycle.confirmResign"),
  };
}
