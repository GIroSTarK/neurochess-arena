import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function DocumentMetadata({
  arena = false,
  playback = false,
}: {
  readonly arena?: boolean;
  readonly playback?: boolean;
}) {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
    document.title = t(
      playback ? "playback.documentTitle" : arena ? "setup.documentTitle" : "app.title",
    );
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        "content",
        t(playback ? "playback.description" : arena ? "setup.description" : "app.description"),
      );
  }, [t, i18n.resolvedLanguage, arena, playback]);
  return null;
}
