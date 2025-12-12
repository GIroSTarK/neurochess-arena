import { useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { getAllProviders } from '../lib/llm';
import type { PlayerColor, ProviderId } from '../types';

interface PlayerConfigProps {
  color: PlayerColor;
}

export function PlayerConfig({ color }: PlayerConfigProps) {
  const { whitePlayer, blackPlayer, setWhitePlayer, setBlackPlayer, status } = useGameStore();

  const [showApiKey, setShowApiKey] = useState(false);

  const config = color === 'white' ? whitePlayer : blackPlayer;
  const setConfig = color === 'white' ? setWhitePlayer : setBlackPlayer;

  const providers = getAllProviders();
  const currentProvider = providers.find((p) => p.id === config.llmConfig.providerId);

  const isPlaying = status === 'playing';

  const colorLabel = color === 'white' ? 'White' : 'Black';
  const colorIcon = color === 'white' ? '♔' : '♚';

  return (
    <div className="glass-panel p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-(--border-color) pb-3">
        <span className="text-2xl">{colorIcon}</span>
        <h3 className="text-lg font-semibold text-(--text-primary)">{colorLabel} Player</h3>
      </div>

      {/* Player Type Selection */}
      <div>
        <label className="label">Player Type</label>
        <div className="flex gap-2">
          <button
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all cursor-pointer disabled:cursor-not-allowed ${
              config.type === 'human'
                ? 'bg-(--accent-primary) text-white'
                : 'bg-(--bg-tertiary) text-(--text-secondary) hover:bg-(--border-color)'
            }`}
            onClick={() => setConfig({ type: 'human' })}
            disabled={isPlaying}
          >
            👤 Human
          </button>
          <button
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all cursor-pointer disabled:cursor-not-allowed ${
              config.type === 'ai'
                ? 'bg-(--accent-primary) text-white'
                : 'bg-(--bg-tertiary) text-(--text-secondary) hover:bg-(--border-color)'
            }`}
            onClick={() => setConfig({ type: 'ai' })}
            disabled={isPlaying}
          >
            🤖 AI
          </button>
        </div>
      </div>

      {/* AI Configuration */}
      {config.type === 'ai' && (
        <div className="space-y-3 pt-2 border-t border-(--border-color)">
          {/* Provider Selection */}
          <div>
            <label className="label">Provider</label>
            <select
              className="select"
              value={config.llmConfig.providerId}
              onChange={(e) => {
                const providerId = e.target.value as ProviderId;
                const provider = providers.find((p) => p.id === providerId);
                setConfig({
                  llmConfig: {
                    ...config.llmConfig,
                    providerId,
                    modelId: provider?.models[0]?.id || '',
                  },
                });
              }}
              disabled={isPlaying}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>

          {/* Model Selection */}
          <div>
            <label className="label">Model</label>
            <select
              className="select"
              value={config.llmConfig.modelId}
              onChange={(e) =>
                setConfig({ llmConfig: { ...config.llmConfig, modelId: e.target.value } })
              }
              disabled={isPlaying}
            >
              {currentProvider?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>

          {/* Custom Model Slug */}
          <div>
            <label className="label">
              Custom Model Slug
              <span className="text-(--text-muted) font-normal ml-1">(optional)</span>
            </label>
            <input
              type="text"
              className="input mono text-sm"
              placeholder="e.g., openai/gpt-4-turbo-preview"
              value={config.llmConfig.customModelSlug || ''}
              onChange={(e) =>
                setConfig({ llmConfig: { ...config.llmConfig, customModelSlug: e.target.value } })
              }
              disabled={isPlaying}
            />
          </div>

          {/* API Key */}
          <div>
            <label className="label">API Key</label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                className="input pr-10 mono text-sm"
                placeholder="Enter your API key..."
                value={config.llmConfig.apiKey}
                onChange={(e) =>
                  setConfig({ llmConfig: { ...config.llmConfig, apiKey: e.target.value } })
                }
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-(--text-muted) hover:text-(--text-primary) transition-colors cursor-pointer"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? '🙈' : '👁️'}
              </button>
            </div>
          </div>

          {/* Advanced Settings */}
          <details className="group">
            <summary className="cursor-pointer text-sm text-(--text-secondary) hover:text-(--text-primary) transition-colors">
              ⚙️ Advanced Settings
            </summary>
            <div className="mt-3 space-y-3 pl-2 border-l-2 border-(--border-color)">
              {/* Temperature */}
              <div>
                <label className="label flex justify-between">
                  <span>Temperature</span>
                  <span className="text-(--accent-primary)">{config.llmConfig.temperature}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={config.llmConfig.temperature}
                  onChange={(e) =>
                    setConfig({
                      llmConfig: { ...config.llmConfig, temperature: parseFloat(e.target.value) },
                    })
                  }
                  className="w-full h-2 bg-(--bg-tertiary) rounded-lg appearance-none cursor-pointer accent-(--accent-primary)"
                  disabled={isPlaying}
                />
              </div>

              {/* Max Retries */}
              <div>
                <label className="label">Max Retries</label>
                <input
                  type="number"
                  className="input"
                  min="1"
                  max="10"
                  value={config.llmConfig.maxRetries}
                  onChange={(e) =>
                    setConfig({
                      llmConfig: { ...config.llmConfig, maxRetries: parseInt(e.target.value) || 3 },
                    })
                  }
                  disabled={isPlaying}
                />
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
