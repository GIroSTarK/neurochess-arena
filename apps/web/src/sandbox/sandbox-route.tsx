import { useAppRoute } from "../routing/route-context";

import { SandboxScreen } from "./sandbox-screen";

export function SandboxRoute() {
  const { apiBaseUrl } = useAppRoute();
  return <SandboxScreen apiBaseUrl={apiBaseUrl} />;
}
