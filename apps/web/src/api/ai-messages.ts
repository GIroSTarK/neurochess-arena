import type { ProviderFailure } from "@neurochess/contracts";
import type { TFunction } from "i18next";

import type { AiRequestFailure } from "./ai-client";

const requestKeys = {
  AI_TURN_IN_PROGRESS: "provider.inProgress",
  AI_TURN_RECOVERY_REQUIRED: "provider.recoveryRequired",
  AI_TURN_CANCELLED: "provider.cancelled",
  AI_ADAPTER_UNAVAILABLE: "provider.adapterUnavailable",
  AI_PARAMETERS_INVALID: "provider.invalidParameters",
  AI_KEY_REQUIRED: "provider.keyRequired",
  AI_CONTROLLER_LOST: "match.controllerLost",
  AI_CONTROLLER_BUSY: "match.controllerBusy",
} as const;

const providerKeys = {
  model_invalid: "provider.invalidOutput",
  provider_auth: "provider.authError",
  provider_quota: "provider.quotaError",
  provider_timeout: "provider.timeoutError",
  provider_unavailable: "provider.unavailableError",
} as const;

export function aiRequestMessage(code: AiRequestFailure["code"], t: TFunction): string {
  return t(requestKeys[code]);
}

export function providerFailureMessage(error: ProviderFailure, t: TFunction): string {
  return t(
    error.code === "provider_unavailable" && error.reason === "unsupported_model"
      ? "provider.unsupportedModel"
      : providerKeys[error.code],
  );
}
