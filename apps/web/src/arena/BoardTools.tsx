import type { ChessColor } from "@neurochess/contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const orientationId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-divider pt-2">
        <Button
          variant="quiet"
          padding="compact"
          className="flex-[1_1_8rem]"
          aria-describedby={orientationId}
          onClick={onFlip}
        >
          <Icon path="M3 11a9 9 0 0 1 15-6l3 3M21 3v5h-5M21 13a9 9 0 0 1-15 6l-3-3M3 21v-5h5" />
          <span className="min-w-0">{t("actions.flip")}</span>
        </Button>
        <Button
          variant="quiet"
          padding="compact"
          className="flex-[1_1_8rem]"
          aria-expanded={helpOpen}
          aria-controls={helpId}
          onClick={() => setHelpOpen((previous) => !previous)}
        >
          <Icon path="M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" />
          <span className="min-w-0">{t("board.keyboardHelp")}</span>
        </Button>
      </div>
      <span id={orientationId} className="sr-only">
        {t(orientation === "white" ? "board.whiteBottom" : "board.blackBottom")}
      </span>
      <p id={helpId} hidden={!helpOpen} className="mt-4 text-body text-text-secondary">
        {t("board.instructions")}
      </p>
    </>
  );
}
