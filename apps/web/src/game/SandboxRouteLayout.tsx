import { useAppRoute } from "../app/route-context";

import { SandboxScreen } from "./SandboxScreen";

export function SandboxRouteLayout() {
  const { apiBaseUrl } = useAppRoute();
  return <SandboxScreen apiBaseUrl={apiBaseUrl} />;
}
