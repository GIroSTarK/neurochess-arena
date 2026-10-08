export interface AiIdentity {
  readonly intent: "account" | "guest";
  readonly expectedAccount?: string;
  readonly signal: AbortSignal;
  verify(): Promise<void>;
  lost?(): void;
}
