import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/orbitron";

import { App } from "./App";
import { parseWebEnvironment } from "./env";
import "./styles.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (rootElement === null) {
  throw new Error("Application root element is missing");
}

const root = createRoot(rootElement);

try {
  const environment = parseWebEnvironment(import.meta.env);
  root.render(
    <StrictMode>
      <App apiBaseUrl={environment.VITE_API_BASE_URL} />
    </StrictMode>,
  );
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Invalid application configuration";
  root.render(
    <StrictMode>
      <main className="configuration-error" role="alert">
        <h1>Configuration unavailable</h1>
        <p>{message}</p>
      </main>
    </StrictMode>,
  );
}
