import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function DocumentMetadata({ arena = false }: { readonly arena?: boolean }) {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
    document.title = t(arena ? "setup.documentTitle" : "app.title");
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t(arena ? "setup.description" : "app.description"));
  }, [t, i18n.resolvedLanguage, arena]);
  return null;
}
