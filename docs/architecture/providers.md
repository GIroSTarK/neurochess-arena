# Provider boundary, telemetry, and cost

The [architecture overview](../architecture.md) separates provider adapters from deterministic game authority. This contract owns discovery, normalization, error classification, invocation telemetry, and cost estimates.

## AI provider boundary

Each provider adapter implements equivalent operations conceptually:

```ts
interface AiProviderAdapter {
  readonly provider: AiProvider;
  listModels(input: ProviderRequestAccess): Promise<ModelDiscoveryResult>;
  requestMove(input: MoveRequest): Promise<NormalizedMoveResponse>;
}
```

`ModelDescriptor` includes capability metadata used to build a capability-aware configuration UI. The server filters unsupported parameters rather than sending speculative fields to a provider.

`ProviderRequestAccess` carries the resolved request-scoped key, cancellation signal, and optional pre-dispatch authorization callback; `MoveRequest` extends it with inference inputs. `ProviderOperationAccess` instead describes an unresolved session key or saved credential reference and signal at the credential resolver's entry point.

Shared schemas distinguish supported, unsupported, and unknown move-generation capability; null parameter capability never enables a speculative control. Normalized operations return discriminated success/failure results with enumerated diagnostics, excluding upstream exception text. Usage may be entirely null or contain independently nullable reported counts; absent totals are never synthesized. Adapter inputs carry cancellation and a request-scoped key, which must not be retained on the adapter. The reusable scripted adapter lives only in API test fixtures, with an architecture guard excluding it from production imports.

The normalized move response contains:

- required UCI move;
- optional viewer commentary;
- latency;
- normalized token usage when available;
- retry and error classification.

`providers/transport.ts` owns bounded JSON reading (4 MiB, fatal UTF-8 decoding, stream cancellation and lock release) and safe transport/cancellation failure normalization. It has no dependency on inference orchestration. Provider HTTP modules retain URLs, headers, pagination, per-request `beforeDispatch` checks, envelopes, error mapping, and billing; they perform no implicit retries.

`providers/move-output.ts` shares pure JSON move parsing and commentary sanitization across the four adapters. Provider envelopes and finish reasons remain adapter-owned. `providers/invoke-move.ts` independently validates the normalized envelope, measures duration, and discards upstream request IDs. For schema-valid output, NUL or key-echo commentary is omitted without rejecting the move; malformed model output remains distinct from malformed provider envelopes, and missing usage remains distinct from reported zero.

Model lists come from the selected provider through the API. Discovery is currently uncached and scoped to the supplied request credential; another account's catalog is never reused. Malformed, mismatched-provider, or credential-echoing descriptors become safe provider failures. A missing or explicitly unsupported selected model pauses a turn without inference. Unknown move-generation capability permits a runtime attempt with no optional parameters. For supported models, unknown/unsupported parameter fields are omitted; values outside an advertised range or enumeration pause the game and return `AI_PARAMETERS_INVALID` before inference, without consuming an invalid-output attempt. Seat configuration is immutable, so a changed range that invalidates a selection requires a new configuration/game. Invocation records contain the parameters actually supplied to inference. Discovery failures retain a safe failure attempt with no effective parameters or token usage.

A model being listed does not guarantee it supports the required chess response contract; adapters must surface capability or runtime errors clearly. Registration is explicit through `aiAdapters`; production has no fixture adapter or fallback.

The [OpenAI adapter](../reference/providers.md#openai-adapter) uses stateless Responses API requests and annotates live model discovery with conservative documented capabilities. The [Anthropic adapter](../reference/providers.md#anthropic-adapter) uses Messages and paginated discovery with advertised output/effort capabilities. The [Google adapter](../reference/providers.md#google-adapter) uses GenerateContent and paginated discovery with advertised generation methods, temperature ranges, and output limits. The [OpenRouter adapter](../reference/providers.md#openrouter-adapter) uses Chat Completions and account-filtered discovery, preserving routed identifiers and advertised capabilities while disabling fallback requests and context compression. An optional pure adapter parameter resolver supplies required wire defaults before invocation persistence; discovered capabilities are passed within the request, never retained on the adapter. These adapters discard raw usage metadata after extracting independently reported counts and separate bounded billing dimensions, and perform no implicit transport retries. The common executor retains all legality, retry-budget, lifecycle, and persistence authority.

## Error taxonomy

Errors are classified before game policy is applied:

| Class                  | Examples                                      | Game effect                      |
| ---------------------- | --------------------------------------------- | -------------------------------- |
| `model_invalid`        | malformed payload, missing move, illegal move | retry twice, then technical loss |
| `provider_auth`        | rejected API key                              | pause                            |
| `provider_quota`       | quota, balance, or rate limit                 | pause                            |
| `provider_timeout`     | provider request timeout                      | pause                            |
| `provider_unavailable` | network or upstream failure                   | pause                            |
| `game_conflict`        | stale version or duplicate command            | refresh current state            |
| `authorization`        | user is not allowed to act                    | reject without changing game     |

Missing commentary is not an error.

## Telemetry and cost

Store operational metadata required by the product: provider/model, attempt number, duration, reported tokens, normalized errors, and estimated cost. Never store raw keys. Do not store raw provider payloads; retain the normalized move and user-facing commentary needed for replay.

Cost calculation uses provider-reported billing dimensions and an exact-match versioned catalogue. Every cost is a standard public list-price estimate, excluding account-specific free tiers, credits, discounts, taxes and surcharges; it does not reconcile invoices. Unknown usage, model, routing, tier or billable dimensions produce an enumerated `unavailable` reason, never zero. The [coverage and maintenance policy](../reference/providers.md#ai-cost-estimates) names supported combinations and source documents; it does not restrict live model discovery or gameplay.

Before dispatch, each invocation copies its price version, source URL, observation date and provider-specific rates into immutable provenance columns. Stable amounts/currency/reasons use typed relational columns; bounded billing dimensions and the variable rate map use `jsonb`. The pure calculator uses integer pico-USD (10^-12 USD), with rates represented as decimal USD per million tokens to six decimal places. It performs no binary floating-point monetary arithmetic or rounding and persists a 12-decimal USD string. A new catalogue version affects only later invocations; reads return stored amounts and provenance without recalculation or external calls. Historical records remain `legacy_record`; unfinished/interrupted dispatches remain `dispatch_unknown`.

Reported input/output/total counts retain their existing independent nullable meanings. Disjoint billable input may be derived only from reliable reported cache counts. OpenAI reasoning is already in output; Anthropic input excludes separately reported cache reads/writes, whose positive writes require both TTL counts; Google candidates and thoughts are separate output charges. Missing measurements never imply zero (a reported zero aggregate cache write proves both TTL counts are zero). Malformed supplementary billing metadata makes only the estimate unavailable; malformed headline usage or provider envelopes still follow the provider-failure policy. Pricing cannot reject a legal move or consume invalid-output budget. Accepted, invalid, known failed and late discarded attempts retain estimates when possible, using the existing atomic outcome, deduplication and deletion fences. No pricing or billing metadata enters model prompts or chess authority.

The web sums stored estimates in integer pico-USD without repricing or rounding away small positive amounts. A move's estimate includes every attempt in its accepted logical turn; its compact latency and token measurements describe only the accepted call. Seat comparisons group by White/Black, even when the model identities match. Whole-game operational totals include attempts without an accepted move and do not change with replay selection. Each metric is independently unavailable if a required measurement or historical AI invocation is missing; cost also exposes known subtotals, coverage and reasons. Human moves have no AI invocation cost. Events retain inspectable measurements and estimates for each attempt. Refresh preserves the last successful history boundary and labels stale/error data; an explicit read can update a late discarded result without a chess revision.
