import {
  type AiGameConfiguration,
  type AiParameters,
  aiParametersSchema,
  type AiProvider,
  type AiSeat,
  type ChessColor,
  type ModelDescriptor,
  type ProviderFailure,
} from "@neurochess/contracts";

export type ParameterDraft = Record<keyof AiParameters, string>;
export const emptyParameters = (): ParameterDraft => ({
  temperature: "",
  reasoningEffort: "",
  maxOutputTokens: "",
});

export type SetupIssue =
  ProviderFailure | { code: "unavailable" | "access" | "key_format" | "creation_uncertain" };

export interface SeatSetupState {
  readonly provider: AiProvider;
  readonly source: "session" | "saved";
  readonly credentialId: string;
  readonly keyReady: boolean;
  readonly keyEpoch: number;
  readonly discovery: "idle" | "loading" | "loaded" | "error";
  readonly models: readonly ModelDescriptor[];
  readonly modelId: string;
  readonly parameters: ParameterDraft;
  readonly issue: SetupIssue | null;
}

export interface SetupState {
  readonly mode: AiGameConfiguration["mode"];
  readonly humanColor: ChessColor;
  readonly seats: Readonly<Record<ChessColor, SeatSetupState>>;
  readonly phase: "checking" | "editing" | "creating" | "conflict" | "unavailable" | "handed-off";
  readonly existingGameId: string | null;
  readonly issue: SetupIssue | null;
}

export function emptySeat(provider: AiProvider, keyEpoch = 0): SeatSetupState {
  return {
    provider,
    source: "session",
    credentialId: "",
    keyReady: false,
    keyEpoch,
    discovery: "idle",
    models: [],
    modelId: "",
    parameters: emptyParameters(),
    issue: null,
  };
}

export function selectedModel(seat: SeatSetupState): ModelDescriptor | undefined {
  return seat.models.find((model) => model.id === seat.modelId && model.provider === seat.provider);
}

export function parameterErrors(seat: SeatSetupState): (keyof AiParameters)[] {
  const capabilities = selectedModel(seat)?.capabilities.parameters;
  if (!capabilities) return [];
  return (Object.keys(seat.parameters) as (keyof AiParameters)[]).filter((name) => {
    const value = seat.parameters[name];
    const capability = capabilities[name];
    if (value === "" || capability === null) return false;
    if (name === "reasoningEffort") {
      return !capabilities.reasoningEffort?.values.includes(value);
    }
    const range = capabilities[name];
    const number = Number(value);
    return (
      !range ||
      !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(number) ||
      number < range.min ||
      number > range.max ||
      (name === "maxOutputTokens" && !Number.isSafeInteger(number))
    );
  });
}

function configuredSeat(seat: SeatSetupState): AiSeat | null {
  const model = selectedModel(seat);
  if (
    !seat.keyReady ||
    seat.discovery !== "loaded" ||
    !model ||
    model.capabilities.moveGeneration === "unsupported" ||
    parameterErrors(seat).length > 0
  ) {
    return null;
  }
  const parameters: AiParameters = {};
  const supported = model.capabilities.parameters;
  if (supported.temperature && seat.parameters.temperature !== "") {
    parameters.temperature = Number(seat.parameters.temperature);
  }
  if (supported.reasoningEffort && seat.parameters.reasoningEffort !== "") {
    parameters.reasoningEffort = seat.parameters.reasoningEffort;
  }
  if (supported.maxOutputTokens && seat.parameters.maxOutputTokens !== "") {
    parameters.maxOutputTokens = Number(seat.parameters.maxOutputTokens);
  }
  if (!aiParametersSchema.safeParse(parameters).success) return null;
  return { type: "ai", provider: seat.provider, modelId: model.id, parameters };
}

export function setupConfiguration(state: SetupState): AiGameConfiguration | null {
  if (state.mode === "ai_vs_human") {
    const aiColor = state.humanColor === "white" ? "black" : "white";
    const ai = configuredSeat(state.seats[aiColor]);
    return ai
      ? {
          mode: "ai_vs_human",
          seats:
            state.humanColor === "white"
              ? { white: { type: "human" }, black: ai }
              : { white: ai, black: { type: "human" } },
        }
      : null;
  }
  const white = configuredSeat(state.seats.white);
  const black = configuredSeat(state.seats.black);
  return white && black ? { mode: "ai_vs_ai", seats: { white, black } } : null;
}
