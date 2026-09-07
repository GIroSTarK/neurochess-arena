import { AiSetup } from "../setup/AiSetup";

import { App, type AppProps } from "./App";

export function ArenaApp(props: AppProps) {
  // Keep existing private sandbox links working alongside the new setup entry point.
  const sandbox =
    window.location.pathname === "/sandbox" ||
    new URL(window.location.href).searchParams.has("game");
  return sandbox ? <App {...props} /> : <AiSetup {...props} />;
}
