import { useGameStore } from '../store/gameStore';

export function DebugPanel() {
  const { debugMode, debugLogs, toggleDebugMode, clearDebugLogs } = useGameStore();

  if (!debugMode) {
    return (
      <button
        className="fixed bottom-4 right-4 btn btn-secondary text-xs opacity-60 hover:opacity-100"
        onClick={toggleDebugMode}
      >
        🐛 Debug
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 w-[500px] max-h-[400px] glass-panel overflow-hidden flex flex-col z-50">
      <div className="flex items-center justify-between p-3 border-b border-(--border-color)">
        <h4 className="font-semibold text-(--text-primary) flex items-center gap-2">
          🐛 Debug Console
        </h4>
        <div className="flex gap-2">
          <button
            className="text-xs text-(--text-muted) hover:text-(--text-primary) cursor-pointer"
            onClick={clearDebugLogs}
          >
            Clear
          </button>
          <button
            className="text-xs text-(--text-muted) hover:text-(--text-primary) cursor-pointer"
            onClick={toggleDebugMode}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 max-h-[320px]">
        {debugLogs.length === 0 ? (
          <div className="text-center text-(--text-muted) py-4 text-sm">
            No debug logs yet. Make an AI move to see prompts and responses.
          </div>
        ) : (
          debugLogs.map((log, index) => (
            <div
              key={index}
              className={`p-2 rounded text-xs ${
                log.type === 'error'
                  ? 'bg-(--accent-danger)/10 border border-(--accent-danger)/30'
                  : log.type === 'prompt'
                    ? 'bg-(--accent-primary)/10 border border-(--accent-primary)/30'
                    : log.type === 'response'
                      ? 'bg-(--accent-success)/10 border border-(--accent-success)/30'
                      : 'bg-(--bg-secondary) border border-(--border-color)'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`font-semibold ${
                    log.type === 'error'
                      ? 'text-(--accent-danger)'
                      : log.type === 'prompt'
                        ? 'text-(--accent-primary)'
                        : log.type === 'response'
                          ? 'text-(--accent-success)'
                          : 'text-(--accent-secondary)'
                  }`}
                >
                  {log.type === 'error'
                    ? '❌'
                    : log.type === 'prompt'
                      ? '📤'
                      : log.type === 'response'
                        ? '📥'
                        : '♟️'}{' '}
                  {log.type.toUpperCase()}
                </span>
                <span className="text-(--text-muted)">
                  [{log.player === 'white' ? '♔' : '♚'} {log.player}]
                </span>
                <span className="text-(--text-muted) ml-auto">
                  {log.timestamp.toLocaleTimeString()}
                </span>
              </div>
              <pre className="whitespace-pre-wrap wrap-break-word text-(--text-secondary) mono max-h-[150px] overflow-y-auto">
                {log.content}
              </pre>
              {log.raw && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-(--text-muted) hover:text-(--text-primary)">
                    Raw response
                  </summary>
                  <pre className="mt-1 p-2 bg-(--bg-primary) rounded text-(--text-muted) mono text-[10px] max-h-[100px] overflow-y-auto">
                    {log.raw}
                  </pre>
                </details>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
