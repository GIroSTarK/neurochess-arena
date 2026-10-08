import {
  type AiParameters,
  type AiProvider,
  aiProviderSchema,
  type ChessColor,
  type ModelDescriptor,
} from "@neurochess/contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "../../board/PieceIcon";
import { Button } from "../../ui/Button";
import { SecretInput } from "../../ui/SecretInput";
import { Select } from "../../ui/Select";

import { CredentialSource, type SavedCredentialChoices } from "./CredentialSource";
import { ModelPicker, setupFieldClass } from "./ModelPicker";

export interface SeatSetupProps {
  readonly color: ChessColor;
  readonly provider: AiProvider;
  readonly keyEpoch: number;
  readonly keyReady: boolean;
  readonly keyInvalid: boolean;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly models: readonly ModelDescriptor[];
  readonly modelId: string;
  readonly parameters: Readonly<Record<keyof AiParameters, string>>;
  readonly invalidParameters: readonly (keyof AiParameters)[];
  readonly message: string;
  readonly error: boolean;
  readonly onProvider: (provider: AiProvider) => void;
  readonly onKey: (key: string) => void;
  readonly onKeyBlur: () => void;
  readonly onDiscover: () => void;
  readonly onModel: (id: string) => void;
  readonly onParameter: (name: keyof AiParameters, value: string) => void;
  readonly credential?: string;
  readonly savedCredentials?: SavedCredentialChoices;
  readonly onCredential?: (value: string) => void;
}

export function SeatSetup(props: SeatSetupProps) {
  const { t } = useTranslation();
  const id = useId();
  const model = props.models.find((model) => model.id === props.modelId);
  return (
    <fieldset className="grid min-w-0 content-start gap-6 rounded-panel border border-divider bg-surface p-4 md:p-6 lg:border-0 lg:bg-transparent">
      <legend className="float-left mb-2 flex w-full items-center gap-3 border-b border-divider pb-4 text-section font-semibold">
        <PieceIcon color={props.color} kind="k" className="size-8 shrink-0" />
        {t(`players.${props.color}`)}
      </legend>
      <div className="grid min-w-0 gap-2 text-label">
        <label htmlFor={`${id}-provider`}>{t("setup.provider")}</label>
        <Select
          id={`${id}-provider`}
          value={props.provider}
          aria-disabled={props.disabled}
          onChange={(event) => {
            const provider = aiProviderSchema.safeParse(event.target.value);
            if (!props.disabled && provider.success) props.onProvider(provider.data);
          }}
        >
          {aiProviderSchema.options.map((provider) => (
            <option key={provider} value={provider}>
              {t(`setup.providers.${provider}`)}
            </option>
          ))}
        </Select>
      </div>
      {props.savedCredentials ? (
        <CredentialSource
          provider={props.provider}
          value={props.credential ?? "session"}
          saved={props.savedCredentials}
          disabled={props.disabled}
          onChange={(value) => props.onCredential?.(value)}
        />
      ) : null}
      {!props.credential || props.credential === "session" ? (
        <SecretField key={props.keyEpoch} {...props} descriptionId={`${id}-status`} />
      ) : null}
      {!props.savedCredentials ? (
        <p className="text-label text-text-secondary">{t("credentials.guestHint")}</p>
      ) : null}
      <div className="grid gap-2">
        <Button
          variant="secondary"
          aria-disabled={props.disabled || props.loading || !props.keyReady}
          aria-describedby={`${id}-status`}
          onClick={props.onDiscover}
        >
          {t(
            props.loading
              ? "setup.loading"
              : props.loaded
                ? "setup.refreshModels"
                : "setup.loadModels",
          )}
        </Button>
        <p
          id={`${id}-status`}
          className={props.error ? "text-body text-danger" : "text-body text-text-secondary"}
        >
          {props.message}
        </p>
      </div>
      <ModelPicker
        models={props.models}
        modelId={props.modelId}
        unavailable={props.disabled || !props.loaded || props.models.length === 0}
        onSelect={props.onModel}
      />
      <details className="min-w-0 border-t border-divider pt-3">
        <summary className="min-h-target cursor-pointer py-2 text-label">
          {t("setup.advanced")}
        </summary>
        <Parameters key={`${props.provider}-${props.modelId}`} {...props} model={model} />
      </details>
    </fieldset>
  );
}

function SecretField(props: SeatSetupProps & { readonly descriptionId: string }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-label">
        {t("setup.apiKey")}
      </label>
      <SecretInput
        id={id}
        showLabel={t("setup.showKey")}
        hideLabel={t("setup.hideKey")}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={4096}
        className={`${setupFieldClass} flex-[1_1_10rem]`}
        readOnly={props.disabled}
        aria-disabled={props.disabled}
        aria-invalid={props.keyInvalid}
        aria-describedby={`${id}-hint ${props.descriptionId}`}
        onChange={(event) => {
          props.onKey(event.currentTarget.value);
        }}
        onBlur={props.onKeyBlur}
      />
      <div id={`${id}-hint`} className="text-label text-text-secondary">
        <p className="font-semibold">{t("setup.sessionOnly")}</p>
        <p className="mt-1">{t("setup.sessionOnlyHint")}</p>
      </div>
    </div>
  );
}

function Parameters(props: SeatSetupProps & { readonly model: ModelDescriptor | undefined }) {
  const { t } = useTranslation();
  const id = useId();
  const [touched, setTouched] = useState<Partial<Record<keyof AiParameters, boolean>>>({});
  const capabilities = props.model?.capabilities.parameters;
  if (!capabilities || !Object.values(capabilities).some(Boolean)) {
    return <p className="mt-2 text-body text-text-secondary">{t("setup.noParameters")}</p>;
  }
  return (
    <div className="mt-3 grid min-w-0 gap-4">
      <p className="text-label text-text-secondary">{t("setup.parameterDefaults")}</p>
      {(["temperature", "reasoningEffort", "maxOutputTokens"] as const).map((name) => {
        const capability = capabilities[name];
        if (!capability) return null;
        const fieldId = `${id}-${name}`;
        const invalid = Boolean(touched[name] && props.invalidParameters.includes(name));
        return (
          <div key={name} className="grid min-w-0 gap-2">
            <label htmlFor={fieldId} className="text-label">
              {t(`setup.parameters.${name}`)}
            </label>
            {"values" in capability ? (
              <Select
                id={fieldId}
                value={props.parameters[name]}
                aria-disabled={props.disabled}
                onChange={(event) => {
                  if (!props.disabled) props.onParameter(name, event.target.value);
                }}
              >
                <option value="">{t("setup.providerDefault")}</option>
                {capability.values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            ) : (
              <>
                <input
                  id={fieldId}
                  className={setupFieldClass}
                  // Native number inputs report partial exponents as empty, which would imply a default.
                  type="text"
                  inputMode={name === "temperature" ? "decimal" : "numeric"}
                  maxLength={64}
                  value={props.parameters[name]}
                  readOnly={props.disabled}
                  aria-disabled={props.disabled}
                  aria-invalid={invalid}
                  aria-describedby={`${fieldId}-hint`}
                  onChange={(event) => props.onParameter(name, event.target.value)}
                  onBlur={() => setTouched((current) => ({ ...current, [name]: true }))}
                />
                <p
                  id={`${fieldId}-hint`}
                  className={invalid ? "text-label text-danger" : "text-label text-text-secondary"}
                >
                  {t(invalid ? "setup.parameterInvalid" : "setup.parameterRange", {
                    min: capability.min,
                    max: capability.max,
                  })}
                </p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
