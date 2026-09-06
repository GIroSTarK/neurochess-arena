import type {
  AiConfiguration,
  ModelContext,
  ModelDiscoveryResult,
  NormalizedMoveResponse,
  ProviderDescriptor,
} from "@neurochess/contracts";

/** Request-scoped credentials only; adapters must never retain or log these inputs. */
export interface ListModelsInput {
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}

export interface MoveRequest extends ListModelsInput {
  readonly configuration: AiConfiguration;
  /** From buildModelContext, never a client snapshot or an enriched replay/export PGN. */
  readonly context: ModelContext;
}

export interface AiProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  listModels(input: ListModelsInput): Promise<ModelDiscoveryResult>;
  /** One attempt; no retries, game mutations, credential retention, or raw exceptions. */
  requestMove(input: MoveRequest): Promise<NormalizedMoveResponse>;
}
