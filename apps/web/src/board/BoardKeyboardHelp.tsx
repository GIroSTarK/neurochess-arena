import { useTranslation } from "react-i18next";

/** The board's keyboard instructions, referenced by the grid through the given id. */
export function BoardKeyboardHelp({ id }: { readonly id: string }) {
  const { t } = useTranslation();
  return (
    <details className="mt-2 text-text-secondary">
      <summary className="min-h-target w-fit max-w-full cursor-pointer py-3 text-label">
        {t("board.keyboardHelp")}
      </summary>
      <p id={id} className="py-2">
        {t("board.instructions")}
      </p>
    </details>
  );
}
