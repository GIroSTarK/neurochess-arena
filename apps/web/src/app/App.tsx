import { SandboxScreen } from "../game/SandboxScreen";

import { DocumentMetadata } from "./DocumentMetadata";

export interface AppProps {
  readonly apiBaseUrl: string;
}

export function App({ apiBaseUrl }: AppProps) {
  return (
    <>
      <DocumentMetadata />
      <SandboxScreen apiBaseUrl={apiBaseUrl} />
    </>
  );
}
