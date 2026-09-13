import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { AppPage } from "./navigation";

export function DocumentMetadata({ page = "arena" }: { readonly page?: AppPage }) {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
    document.title =
      page === "reference"
        ? t("reference.documentTitle")
        : page === "sandbox"
          ? t("sandbox.documentTitle")
          : page === "not-found"
            ? t("notFound.documentTitle")
            : t("app.title");
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        "content",
        page === "sandbox" ? t("sandbox.documentDescription") : t("app.description"),
      );
  }, [t, i18n.resolvedLanguage, page]);
  return null;
}
