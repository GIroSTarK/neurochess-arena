import { useApiStatus, type ConnectionStatus } from "./use-api-status";

export interface AppProps {
  readonly apiBaseUrl: string;
}

const statusLabels: Record<ConnectionStatus, string> = {
  checking: "Checking",
  connected: "Connected",
  unavailable: "Unavailable",
};

export function App({ apiBaseUrl }: AppProps) {
  const apiStatus = useApiStatus(apiBaseUrl);

  return (
    <main className="app-shell">
      <p className="wordmark" aria-hidden="true">
        Neurochess Arena
      </p>

      <section className="arena-frame" aria-labelledby="foundation-title">
        <div className="arena-frame__surface">
          <header className="foundation-header">
            <h1>Neurochess Arena</h1>
            <p id="foundation-title">Foundation ready</p>
          </header>

          <div className="status-list" aria-label="Foundation status">
            <StatusRow label="Web workspace" status="connected" />
            <StatusRow label="API connection" status={apiStatus} live />
          </div>
        </div>
      </section>
    </main>
  );
}

interface StatusRowProps {
  readonly label: string;
  readonly live?: boolean;
  readonly status: ConnectionStatus;
}

function StatusRow({ label, live = false, status }: StatusRowProps) {
  return (
    <div className="status-row">
      <div className="status-row__surface">
        <span className="status-row__label">{label}</span>
        <span className={`status status--${status}`} aria-live={live ? "polite" : undefined}>
          <span className="status__dot" aria-hidden="true" />
          <span>{statusLabels[status]}</span>
        </span>
      </div>
    </div>
  );
}
