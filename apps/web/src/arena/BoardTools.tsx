import type { ChessColor } from "@neurochess/contracts";
import { useTranslation } from "react-i18next";

import { BoardKeyboardHelp } from "../board/BoardKeyboardHelp";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

export function BoardTools({
  orientation,
  onFlip,
  helpId,
}: {
  readonly orientation: ChessColor;
  readonly onFlip: () => void;
  readonly helpId: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Button variant="secondary" className="flex-auto" onClick={onFlip}>
          <Icon path="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />
          {t("actions.flip")}
        </Button>
        <span className="text-right text-label text-text-secondary">
          {t(orientation === "white" ? "board.whiteBottom" : "board.blackBottom")}
        </span>
      </div>
      <BoardKeyboardHelp id={helpId} />
    </>
  );
}
