import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function DocumentMetadata() {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
    document.title = t("app.title");
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t("app.description"));
  }, [t, i18n.resolvedLanguage]);
  return null;
}
