import { useTranslation } from "react-i18next";

import { DocumentMetadata } from "./DocumentMetadata";
import { WebEnvironmentValidationError } from "./env";

export function ConfigurationError({ error }: { readonly error: unknown }) {
  const { t } = useTranslation();
  return (
    <main className="grid min-h-screen content-center justify-items-center gap-6 p-6 text-center">
      <DocumentMetadata />
      <h1 className="font-display text-title font-medium">{t("configuration.title")}</h1>
      <p className="max-w-2xl text-text-secondary">{t("configuration.description")}</p>
      {error instanceof WebEnvironmentValidationError ? (
        <p className="max-w-2xl text-text-secondary">
          {t("configuration.variables", { variables: error.variables.join(", ") })}
        </p>
      ) : null}
    </main>
  );
}
