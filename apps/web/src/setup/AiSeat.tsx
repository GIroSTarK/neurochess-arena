import { type ChessColor, type ProviderDescriptor, providerIdSchema } from "@neurochess/contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "../board/PieceIcon";
import { Button } from "../ui/Button";

import { fieldClass, ModelPicker } from "./ModelPicker";
import type { AiSeatState } from "./useAiSeat";

export function AiSeat({
  color,
  seat,
  providers,
  disabled,
}: {
  readonly color: ChessColor;
  readonly seat: AiSeatState;
  readonly providers: ProviderDescriptor[];
  readonly disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);
  const [touchedNumbers, setTouchedNumbers] = useState<ReadonlySet<string>>(() => new Set());
  const { draft, discovery, model } = seat;
  const supported = model?.supportedParameters;
  const unsupported = supported
    ? (["temperature", "reasoningEffort", "maxOutputTokens"] as const)
        .filter((name) => !supported[name])
        .map((name) => t(`setup.${name}`))
    : [];
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  return (
    <section
      aria-label={t("setup.seat", { color: t(`players.${color}`) })}
      className="min-w-0 rounded-panel border border-divider bg-surface p-4 md:p-6"
    >
      <h2 className="mb-6 flex items-center gap-3 font-display text-section">
        <PieceIcon color={color} kind="k" className="size-10" />
        {t(`players.${color}`)}
      </h2>
      <div className="space-y-5">
        <div>
          <label htmlFor={`${id}-provider`} className="mb-2 block text-label font-semibold">
            {t("setup.provider")}
          </label>
          <select
            id={`${id}-provider`}
            className={fieldClass}
            value={draft.provider}
            aria-disabled={disabled}
            onChange={(event) => {
              if (disabled) return;
              const parsed = providerIdSchema.safeParse(event.target.value);
              seat.changeProvider(parsed.success ? parsed.data : "");
              setRevealed(false);
              setKeyTouched(false);
              setTouchedNumbers(new Set());
            }}
          >
            <option value="">{t("setup.chooseProvider")}</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-key`} className="mb-2 block text-label font-semibold">
            {t("setup.key")}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`${id}-key`}
              type={revealed ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              maxLength={4096}
              value={seat.key}
              readOnly={disabled || !draft.provider}
              aria-disabled={disabled || !draft.provider}
              aria-invalid={keyTouched && !seat.credentialReady}
              aria-describedby={`${id}-key-hint${keyTouched && !seat.credentialReady ? ` ${id}-key-error` : ""}`}
              className={`${fieldClass} flex-[1_1_12rem]`}
              onBlur={() => setKeyTouched(true)}
              onChange={(event) => {
                if (!disabled) seat.changeKey(event.target.value);
              }}
            />
            <Button
              variant="secondary"
              aria-pressed={revealed}
              aria-disabled={disabled || !seat.key}
              onClick={() => setRevealed(!revealed)}
            >
              {t(revealed ? "setup.hideKey" : "setup.showKey")}
            </Button>
          </div>
          <p id={`${id}-key-hint`} className="mt-2 text-label text-text-secondary">
            <strong>{t("setup.keyScope")}</strong> {t("setup.keyHint")}
          </p>
          {keyTouched && !seat.credentialReady ? (
            <p id={`${id}-key-error`} className="mt-2 text-label text-danger">
              {t("setup.invalidKey")}
            </p>
          ) : null}
        </div>
        <Button
          variant="secondary"
          className="w-full"
          aria-disabled={disabled || !seat.credentialReady || discovery.status === "loading"}
          onClick={() => {
            void seat.discover();
          }}
        >
          {t(discovery.status === "loading" ? "setup.loadingModels" : "setup.loadModels")}
        </Button>
        <div role="status" aria-live="polite" className="text-label text-text-secondary">
          {discovery.status === "idle" ? t("setup.discoveryHint") : null}
          {discovery.status === "loading" ? t("setup.discoveryLoading") : null}
          {discovery.status === "error" ? (
            <p className="text-warning">{t(`setup.discoveryErrors.${discovery.kind}`)}</p>
          ) : null}
          {discovery.status === "ready"
            ? t(discovery.models.length ? "setup.discoveryReady" : "setup.discoveryEmpty", {
                count: discovery.models.length,
              })
            : null}
        </div>
        {discovery.status === "ready" && discovery.models.length > 0 ? (
          <ModelPicker
            key={discovery.expiresAt}
            models={discovery.models}
            modelId={draft.modelId}
            disabled={disabled}
            onSelect={(modelId) => {
              setTouchedNumbers(new Set());
              seat.changeModel(modelId);
            }}
          />
        ) : null}
        {supported ? (
          <details className="rounded-control border border-divider p-3">
            <summary className="min-h-target content-center text-label font-semibold">
              {t("setup.advanced")}
            </summary>
            <div className="mt-3 space-y-4">
              <p className="text-label text-text-secondary">{t("setup.defaults")}</p>
              {(["temperature", "maxOutputTokens"] as const).map((name) => {
                const range = supported[name];
                if (!range) return null;
                const value = draft[name] === "" ? null : Number(draft[name]);
                const invalid =
                  touchedNumbers.has(name) &&
                  (seat.invalidNumbers.has(name) ||
                    (value !== null &&
                      (!Number.isFinite(value) ||
                        value < range.min ||
                        value > range.max ||
                        (name === "maxOutputTokens" && !Number.isSafeInteger(value)))));
                return (
                  <div key={name}>
                    <label htmlFor={`${id}-${name}`} className="mb-2 block text-label">
                      {t(`setup.${name}`)}
                    </label>
                    <input
                      id={`${id}-${name}`}
                      type="number"
                      min={range.min}
                      max={range.max}
                      step={name === "temperature" ? "any" : 1}
                      className={fieldClass}
                      value={draft[name]}
                      readOnly={disabled}
                      aria-disabled={disabled}
                      aria-invalid={invalid}
                      aria-describedby={`${id}-${name}-range`}
                      placeholder={t("setup.providerDefault")}
                      onBlur={() => setTouchedNumbers((previous) => new Set([...previous, name]))}
                      onInput={(event) => {
                        if (!disabled) {
                          seat.changeParameter(
                            name,
                            event.currentTarget.value,
                            event.currentTarget.validity.badInput,
                          );
                        }
                      }}
                    />
                    <p
                      id={`${id}-${name}-range`}
                      className={`mt-2 text-label ${invalid ? "text-danger" : "text-text-secondary"}`}
                    >
                      {t("setup.range", {
                        min: number.format(range.min),
                        max: number.format(range.max),
                      })}
                    </p>
                  </div>
                );
              })}
              {supported.reasoningEffort ? (
                <div>
                  <label htmlFor={`${id}-effort`} className="mb-2 block text-label">
                    {t("setup.reasoningEffort")}
                  </label>
                  <select
                    id={`${id}-effort`}
                    className={fieldClass}
                    value={draft.reasoningEffort}
                    aria-disabled={disabled}
                    onChange={(event) => {
                      if (!disabled) seat.changeParameter("reasoningEffort", event.target.value);
                    }}
                  >
                    <option value="">{t("setup.providerDefault")}</option>
                    {supported.reasoningEffort.values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {unsupported.length ? (
                <p className="text-label text-text-muted">
                  {t("setup.unsupported", {
                    parameters: new Intl.ListFormat(i18n.resolvedLanguage).format(unsupported),
                  })}
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
        {model && Object.keys(model.supportedParameters).length === 0 ? (
          <p className="text-label text-warning">{t("setup.noCapabilities")}</p>
        ) : null}
        <p className={`text-label ${seat.ready ? "text-success" : "text-text-secondary"}`}>
          {t(seat.ready ? "setup.seatReady" : "setup.seatIncomplete")}
        </p>
      </div>
    </section>
  );
}
