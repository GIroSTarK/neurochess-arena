import { useEffect, useState } from "react";

import { checkApiHealth } from "./api";

export type ConnectionStatus = "checking" | "connected" | "unavailable";

export function useApiStatus(apiBaseUrl: string): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();

    void checkApiHealth(apiBaseUrl, controller.signal).then(
      () => setStatus("connected"),
      () => {
        if (!controller.signal.aborted) {
          setStatus("unavailable");
        }
      },
    );

    return () => controller.abort();
  }, [apiBaseUrl]);

  return status;
}
