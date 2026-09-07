import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function DocumentMetadata({
  arena = false,
  matchMode,
}: {
  readonly arena?: boolean;
  readonly matchMode?: "ai_vs_ai" | "ai_vs_human" | undefined;
}) {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    const liveCopy = matchMode === "ai_vs_human" ? "humanPlay" : "playback";
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
    document.title = t(
      matchMode ? `${liveCopy}.documentTitle` : arena ? "setup.documentTitle" : "app.title",
    );
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        "content",
        t(matchMode ? `${liveCopy}.description` : arena ? "setup.description" : "app.description"),
      );
  }, [t, i18n.resolvedLanguage, arena, matchMode]);
  return null;
}
