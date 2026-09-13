import { type BoardInspectionProps, useBoardInspection } from "./useBoardInspection";

export function BoardTools(props: BoardInspectionProps) {
  const { flipButton, helpButton, descriptions } = useBoardInspection(props, {
    flipVariant: "quiet",
    flipClassName: "flex-[1_1_8rem]",
    helpClassName: "flex-[1_1_8rem]",
  });
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-divider pt-2">
        {flipButton}
        {helpButton}
      </div>
      {descriptions}
    </>
  );
}
