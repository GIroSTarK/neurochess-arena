import {
  ChessBoardComponent,
  PlayerConfig,
  ControlsPanel,
  MoveHistory,
  DebugPanel,
} from './components';

function App() {
  return (
    <div className="min-h-screen bg-(--bg-primary)">
      {/* Background gradient */}
      <div className="fixed inset-0 bg-linear-to-br from-[#0a0a0f] via-[#12121a] to-[#1a1525] -z-10" />
      <div
        className="fixed inset-0 opacity-30 -z-10"
        style={{
          backgroundImage: `radial-gradient(circle at 20% 50%, rgba(124, 92, 255, 0.1) 0%, transparent 50%),
                           radial-gradient(circle at 80% 50%, rgba(92, 156, 255, 0.1) 0%, transparent 50%)`,
        }}
      />

      {/* Header */}
      <header className="border-b border-(--border-color) bg-(--bg-secondary)/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">♞</span>
              <div>
                <h1 className="text-xl font-bold text-(--text-primary)">NeuroChess Arena</h1>
                <p className="text-xs text-(--text-muted)">
                  Human vs AI • AI vs AI • Chess Battles
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-(--text-muted) hover:text-(--text-primary) transition-colors"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
                  />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1400px] mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_320px] gap-6 items-start">
          {/* Left Panel - White Player Config */}
          <div className="space-y-6">
            <PlayerConfig color="white" />
          </div>

          {/* Center - Chess Board & Controls */}
          <div className="flex flex-col items-center gap-6">
            <ChessBoardComponent />
            <div className="w-[560px]">
              <ControlsPanel />
            </div>
          </div>

          {/* Right Panel - Black Player Config & Move History */}
          <div className="space-y-6">
            <PlayerConfig color="black" />
            <MoveHistory />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-(--border-color) bg-(--bg-secondary)/50 mt-8">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-(--text-muted)">
            <p>Built with React, TypeScript, chess.js & Zustand</p>
          </div>
        </div>
      </footer>

      {/* Debug Panel */}
      <DebugPanel />
    </div>
  );
}

export default App;
