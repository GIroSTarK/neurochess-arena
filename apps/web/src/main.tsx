import "./app/browser-validation";
import "@fontsource-variable/orbitron";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { App } from "./app/app";
import { ConfigurationError } from "./app/configuration-error";
import { parseWebEnvironment } from "./app/env";
import { ErrorBoundary } from "./app/error-boundary";
import { createAppRouter } from "./app/router";
import { consumeAuthEntry } from "./auth/auth-entry";
import { i18n } from "./i18n";

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (rootElement === null) {
  throw new Error(i18n.t("configuration.rootMissing"));
}

const root = createRoot(rootElement);
const authEntry = consumeAuthEntry();

try {
  const environment = parseWebEnvironment({
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    SANDBOX_ENABLED: import.meta.env.SANDBOX_ENABLED,
  });
  const router = createAppRouter({
    apiBaseUrl: environment.VITE_API_BASE_URL,
    sandboxEnabled: environment.SANDBOX_ENABLED,
    authEntry,
  });
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <App router={router} />
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>,
  );
} catch (error: unknown) {
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ConfigurationError error={error} />
      </I18nextProvider>
    </StrictMode>,
  );
}
