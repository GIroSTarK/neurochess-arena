import { useTranslation } from "react-i18next";

import { DocumentMetadata } from "./DocumentMetadata";
import { WebEnvironmentValidationError } from "./env";

export function ConfigurationError({ error }: { readonly error: unknown }) {
  const { t } = useTranslation();
  return (
    <main className="configuration-error">
      <DocumentMetadata />
      <h1>{t("configuration.title")}</h1>
      <p>{t("configuration.description")}</p>
      {error instanceof WebEnvironmentValidationError ? (
        <p>{t("configuration.variables", { variables: error.variables.join(", ") })}</p>
      ) : null}
    </main>
  );
}
