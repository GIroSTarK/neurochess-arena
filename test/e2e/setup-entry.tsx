import "@fontsource-variable/inter";
import "@fontsource-variable/orbitron";
import "../../apps/web/src/styles.css";

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";

import { createAiApi } from "../../apps/web/src/api/ai-client";
import { createSessionCredentials } from "../../apps/web/src/api/session-credentials";
import { i18n } from "../../apps/web/src/i18n";
import { ArenaSetupScreen } from "../../apps/web/src/setup/ArenaSetupScreen";

import { API_ORIGIN } from "./environment";

const lifetime = new AbortController();
const credentials = createSessionCredentials(lifetime.signal);
const api = createAiApi(API_ORIGIN);

function SetupHarness() {
  const [handoff, setHandoff] = useState<string | null>(null);
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <p className="p-4 text-center text-label text-warning">
          Test harness · Fictional models · No game controller
        </p>
        {handoff ? (
          <p role="status">Handoff received: {handoff}</p>
        ) : (
          <ArenaSetupScreen
            api={api}
            credentials={credentials}
            sandboxEnabled
            onCreated={(game) => setHandoff(game.snapshot.gameId)}
            onReturnToGame={setHandoff}
          />
        )}
      </MemoryRouter>
    </I18nextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<SetupHarness />);
