import { useTranslation } from "react-i18next";

import { type BoardInspectionProps, useBoardInspection } from "./use-board-inspection";

export function BoardTools(props: BoardInspectionProps) {
  const { t } = useTranslation();
  const { flipButton, helpButton, descriptions } = useBoardInspection(props, {
    flipVariant: "quiet",
    flipClassName: "flex-[1_1_8rem]",
    helpClassName: "flex-[1_1_8rem]",
  });
  return (
    <>
      <div
        role="group"
        aria-label={t("board.tools")}
        className="mt-4 flex flex-wrap gap-2 border-t border-divider pt-2"
      >
        {flipButton}
        {helpButton}
      </div>
      {descriptions}
    </>
  );
}
