import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

// This entry exists only on the isolated test server, never in App or a shipped bundle.
export function setupHarness(): Plugin {
  const entry = fileURLToPath(new URL("./setup-entry.tsx", import.meta.url)).replaceAll("\\", "/");
  const roomEntry = fileURLToPath(new URL("./room-entry.tsx", import.meta.url)).replaceAll(
    "\\",
    "/",
  );
  return {
    name: "arena-setup-test-harness",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const room =
          pathname === "/__test__" ||
          (pathname.startsWith("/__test__/") && pathname !== "/__test__/setup");
        if (request.url !== "/__test__/setup" && !room) {
          next();
          return;
        }
        void server
          .transformIndexHtml(
            request.url!,
            `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Arena setup test harness</title></head><body><div id="root"></div><script type="module" src="/@fs/${room ? roomEntry : entry}"></script></body></html>`,
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
