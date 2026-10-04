import "@fontsource-variable/inter";
import "@fontsource-variable/orbitron";
import "../../apps/web/src/styles.css";

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createMemoryRouter, useLoaderData, useRevalidator } from "react-router";
import { RouterProvider } from "react-router/dom";

import { createAiApi } from "../../apps/web/src/api/ai-client";
import { ApiFailure } from "../../apps/web/src/api/failures";
import { createSessionCredentials } from "../../apps/web/src/api/session-credentials";
import { i18n } from "../../apps/web/src/i18n";
import { ArenaSetupScreen } from "../../apps/web/src/setup/ArenaSetupScreen";
import type { SetupEntry } from "../../apps/web/src/setup/controller";

import { API_ORIGIN } from "./environment";

const lifetime = new AbortController();
const credentials = createSessionCredentials(lifetime.signal);
const api = createAiApi(API_ORIGIN);
let entrySequence = 0;

function SetupHarness() {
  const [handoff, setHandoff] = useState<string | null>(null);
  const { entry, sequence } = useLoaderData<{ entry: SetupEntry; sequence: number }>();
  const revalidator = useRevalidator();
  return (
    <>
      <p className="p-4 text-center text-label text-warning">
        Test harness · Fictional models · No game controller
      </p>
      {handoff ? (
        <p role="status">Handoff received: {handoff}</p>
      ) : (
        <ArenaSetupScreen
          key={sequence}
          api={api}
          credentials={credentials}
          entry={entry}
          onRetry={() => {
            void revalidator.revalidate();
          }}
          sandboxEnabled
          onCreated={(game) => setHandoff(game.snapshot.gameId)}
          onReturnToGame={setHandoff}
        />
      )}
    </>
  );
}

const router = createMemoryRouter([
  {
    path: "*",
    loader: async ({ request }) => {
      const sequence = ++entrySequence;
      let entry: SetupEntry;
      try {
        const game = await api.unfinished(request.signal);
        entry = { existingGameId: game?.snapshot.gameId ?? null, issue: null };
      } catch (error) {
        entry = {
          existingGameId: null,
          issue:
            error instanceof ApiFailure && error.code === "UNAUTHORIZED"
              ? null
              : { code: "unavailable" },
        };
      }
      return { entry, sequence };
    },
    Component: SetupHarness,
    hydrateFallbackElement: <></>,
  },
]);

createRoot(document.getElementById("root")!).render(
  <I18nextProvider i18n={i18n}>
    <RouterProvider router={router} />
  </I18nextProvider>,
);
