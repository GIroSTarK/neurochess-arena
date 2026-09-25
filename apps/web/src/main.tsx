import "@fontsource-variable/orbitron";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { App } from "./app/App";
import { ConfigurationError } from "./app/ConfigurationError";
import { parseWebEnvironment } from "./app/env";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { consumeAuthEntry } from "./auth/navigation";
import { i18n } from "./i18n";

const authEntry = consumeAuthEntry();

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (rootElement === null) {
  throw new Error(i18n.t("configuration.rootMissing"));
}

const root = createRoot(rootElement);

try {
  const environment = parseWebEnvironment({
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    SANDBOX_ENABLED: import.meta.env.SANDBOX_ENABLED,
  });
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <App
            authEntry={authEntry}
            apiBaseUrl={environment.VITE_API_BASE_URL}
            sandboxEnabled={environment.SANDBOX_ENABLED}
          />
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
