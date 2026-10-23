import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

// This entry exists only on the isolated test server, never in App or a shipped bundle.
export function setupHarness(): Plugin {
  const entry = fileURLToPath(new URL("./setup-entry.tsx", import.meta.url)).replaceAll("\\", "/");
  return {
    name: "arena-setup-test-harness",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/__test__/setup") {
          next();
          return;
        }
        void server
          .transformIndexHtml(
            request.url,
            `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Arena setup test harness</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`,
          )
          .then((html) => {
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          })
          .catch(next);
      });
    },
  };
}
