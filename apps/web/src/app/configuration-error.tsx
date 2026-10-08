import { useTranslation } from "react-i18next";

import { FullPageNotice } from "../shell/full-page-notice";

import { WebEnvironmentValidationError } from "./env";

export function ConfigurationError({ error }: { readonly error: unknown }) {
  const { t } = useTranslation();
  return (
    <FullPageNotice title={t("configuration.title")} description={t("configuration.description")}>
      {error instanceof WebEnvironmentValidationError ? (
        <p className="max-w-2xl text-text-secondary">
          {t("configuration.variables", { variables: error.variables.join(", ") })}
        </p>
      ) : null}
    </FullPageNotice>
  );
}
