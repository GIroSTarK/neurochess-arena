# Development guide

## Local setup

Use Node.js 24 and npm 11. From a clean clone:

```text
npm ci
```

Build, watch, and type-check commands use the native TypeScript 7 compiler through the `@typescript/native` npm alias, which provides `tsc`. Keep `typescript` aliased to `@typescript/typescript6` so ESLint and dependency-cruiser can use the TypeScript 6 compiler API. Retain both aliases when updating the toolchain; see the [upstream compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

Copy `.env.example` to `.env`. The committed values are local placeholders only; never place production credentials in the repository.

Start PostgreSQL and wait for its health check:

```text
npm run infra:up
```

Apply the reviewed migration history, then start the TypeScript package watchers, Fastify API, and Vite app:

```text
npm run db:migrate
npm run dev
```

The API reads the root `.env` file when present. Vite also uses the root as its environment directory but exposes only variables prefixed with `VITE_`.

## Environment contract

| Variable                    | Consumer   | Purpose                                                                   |
| --------------------------- | ---------- | ------------------------------------------------------------------------- |
| `NODE_ENV`                  | API        | `development`, `test`, or `production`                                    |
| `API_HOST`                  | API        | Fastify listen address                                                    |
| `API_PORT`                  | API        | Fastify listen port                                                       |
| `WEB_ORIGIN`                | API        | Exact browser origin allowed by CORS                                      |
| `DATABASE_URL`              | API, tools | PostgreSQL connection URL                                                 |
| `LOG_LEVEL`                 | API        | Pino log level                                                            |
| `SANDBOX_ENABLED`           | API        | Exactly `true` or `false`; defaults to false; production rejects true     |
| `GUEST_SESSION_TTL_SECONDS` | API        | Inactivity expiry, 1–31536000 seconds; defaults to 86400                  |
| `VITE_API_BASE_URL`         | web        | Public HTTP(S) API origin, without credentials, paths, query, or fragment |
| `POSTGRES_*`                | Compose    | Local database name, user, password, and port                             |
| `TEST_DATABASE_URL`         | Tests      | Explicit disposable PostgreSQL database ending in `_test`; no fallback    |
| `TEST_POSTGRES_PORT`        | Compose    | Separate test-service port, defaults to 5433                              |

Invalid environment errors contain variable names only. Never add server secrets to a `VITE_` variable.

## Root commands

| Command                      | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                | Build shared packages, watch them, and run both applications     |
| `npm run build`              | Build shared packages, the API, and the Vite production bundle   |
| `npm start`                  | Run the built API and web preview                                |
| `npm run lint`               | Run ESLint with zero warnings                                    |
| `npm run typecheck`          | Type-check project references and tests                          |
| `npm test`                   | Run unit, PostgreSQL integration, and dependency-boundary checks |
| `npm run test:unit`          | Run database-free unit tests                                     |
| `npm run test:integration`   | Run required PostgreSQL-backed tests; fail if unavailable        |
| `npm run test:e2e`           | Run desktop/mobile browser gameplay and accessibility checks     |
| `npm run format:check`       | Verify Prettier formatting                                       |
| `npm run verify`             | Run formatting, lint, types, tests, and build                    |
| `npm run smoke`              | Start and probe both built services                              |
| `npm run infra:up`           | Start and health-check PostgreSQL                                |
| `npm run infra:test:up`      | Start the isolated disposable test PostgreSQL service            |
| `npm run infra:down`         | Stop PostgreSQL while preserving data                            |
| `npm run db:generate -- ...` | Generate a named Drizzle migration                               |
| `npm run db:check`           | Check migration metadata for consistency                         |
| `npm run db:migrate`         | Apply pending migrations                                         |
| `npm run db:studio`          | Open Drizzle Studio                                              |

## Dependency direction

- `apps/web` may consume `packages/contracts` and presentation-safe exports from `packages/chess`.
- `apps/api` may consume `packages/contracts`, `packages/chess`, and `packages/database`.
- `packages/contracts` and `packages/chess` are infrastructure-independent leaves.
- `packages/database` is server-only and does not depend on application code.
- Product packages expose explicit entrypoints; consumers must not deep-import their source files.

`npm run test:architecture` validates the real graph, including external dependency edges without traversing dependency implementations. Deliberately invalid fixtures prove the web/database boundary, both independent leaves, rules-engine encapsulation, public entrypoints, the shared-package infrastructure restrictions, and exclusion of chess test helpers from production imports.

## Chess domain development

The [domain and core contract boundary](architecture.md#deterministic-domain-and-core-contracts) remains independent of HTTP and persistence. The API now consumes it through the guest command service. Import only package entrypoints. `createGame()` starts in `configuring`; call `start()` before submitting canonical UCI. Snapshot and command results contain copied data. `restoreGame({ moves, lifecycle })` replays ordered UCI moves and validates the supplied lifecycle instead of accepting a cached FEN or PGN.

Focused checks require neither PostgreSQL nor provider credentials:

```text
npm exec vitest -- run packages/chess/test packages/contracts apps/api/src/game-contracts.test.ts
npm run test:architecture
```

Special-position fixtures live in `packages/chess/test`, outside the production TypeScript root and package exports. They exercise the internal adapter through the same aggregate used by public factories. Do not export a FEN constructor, import fixtures into production, or replace the normalized repetition key with the engine's built-in hash. The regression tests cover pinned en passant, restoration between repetition cycles, and the 99-to-100 half-move boundary.

## Provider contract tests

Run the shared AI schemas, canonical context, parameter resolution, and scripted provider checks without network access or provider credentials:

```text
npm exec vitest -- run packages/contracts/src/ai.test.ts packages/contracts/src/provider-transport.test.ts apps/api/src/providers
```

Use `createScriptedMockProvider` from `apps/api/src/providers/mock.ts` in server tests. Supply a provider descriptor, fixture model descriptors, and ordered move steps containing either `output` (structured data or JSON text, including malformed fixtures) or a classified provider `error`. Optional telemetry supplies deterministic latency and reported usage; omitted telemetry means simulated zero latency and unavailable usage. `discoveryError` scripts a model-list failure. The mock consumes one step per valid request and throws `MOCK_SCRIPT_EXHAUSTED` when the script runs out, so unintended extra attempts fail tests.

Request captures contain defensive copies of effective configuration, canonical context, and the common response instruction; they omit API keys and abort signals. Use placeholder credentials only. The mock does not perform retries or game commands. Integration tests inject it into the real [guest AI service](#guest-ai-game-api). The reusable `apps/api/test/provider-contract.ts` suite also runs against real adapters with mocked HTTP. The [provider registry](architecture.md#ai-provider-boundary) validates discovery and move results before response serialization, caching, or persistence.

## OpenAI adapter

`createOpenAiProvider` uses native server-side `fetch` for [model discovery](https://developers.openai.com/api/reference/resources/models/methods/list) and [Responses requests](https://developers.openai.com/api/reference/resources/responses/methods/create). The normal server registers it through the existing AI composition. It reads only the key supplied for the current operation, never an environment key, and performs no call on startup. Tests inject `fetch` and a clock; no SDK retry or paid request is involved. Requests use the fixed HTTPS API origin, reject redirects, honor cancellation through body consumption, and have a 120-second transport timeout. This timeout pauses on failure; it is not a chess clock or a user-configurable game control.

OpenAI discovery supplies IDs and ownership/availability metadata, not capability limits. The adapter returns every validated discovered ID, using the ID as its name. `openai-models.ts` supplements exact documented IDs and snapshots with conservative parameter ranges and Structured Outputs support; it never expands the available model list. Unknown, fine-tuned, and specialized IDs remain listed with no advertised parameters and receive the common JSON instruction without a schema format. Endpoint incompatibility is a provider failure. Extend compatibility metadata only after checking the exact model's official documentation; do not extrapolate from an ID prefix or an unverified future snapshot.

Compatibility sources, checked 2026-09-06: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-5.6 Sol and its alias](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [GPT-4.1 Mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), and [GPT-4o Mini](https://developers.openai.com/api/docs/models/gpt-4o-mini). Output-token controls start at 16 and respect the documented maximum. Reasoning models advertise documented effort values and omit temperature conservatively because the shared capability shape cannot express effort-dependent support. Non-reasoning profiles expose the API's 0–2 temperature range.

Each move request sends the common instruction and canonical context independently, with `store: false`, no tools, and no prior response/conversation state. Known compatible models use [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) with an enum of legal UCI moves. OpenAI requires every schema property, so nullable commentary represents absence; both omitted and null commentary normalize to the shared optional field. Only completed assistant output text is parsed; reasoning items are ignored. Refusals, incomplete generation, and malformed/illegal move payloads are `model_invalid`. Malformed JSON transport/envelopes and upstream execution failures are provider failures, never technical losses. [HTTP errors](https://developers.openai.com/api/docs/guides/error-codes) map 401/403 to auth, 429 to quota, 408/504 to timeout, and other failures to unavailability, without retaining upstream messages. Failed Responses with `rate_limit_exceeded` map to quota.

Latency includes HTTP and response-body time. Only safe `resp_` identifiers and individually validated reported token counts enter telemetry; absent/invalid counts remain unavailable and totals are never inferred. Credential echoes in retained fields are rejected. Cost remains unavailable without pricing metadata. Shared contract, adapter, and PostgreSQL integration tests cover these paths with mocked HTTP only.

## Anthropic adapter

`createAnthropicProvider` is registered alongside OpenAI in the normal server and implements the same discovery/move interface using native server-side `fetch`. It uses only the current operation's key, the fixed `https://api.anthropic.com/v1` origin, `x-api-key`, and `anthropic-version: 2023-06-01`. There are no startup calls, environment credentials, SDK retries, or automatic follow-up requests. Each HTTP exchange rejects redirects, honors cancellation through body consumption, and has a 120-second transport timeout. Fixtures inject HTTP and a clock; automated tests never call a paid provider.

[Models discovery](https://platform.claude.com/docs/en/api/models/list) follows `has_more`/`last_id` pagination with 1,000-item pages, rejecting duplicates, invalid cursors, more than 2,000 models, or more than 20 pages. Availability and display names come from the provider. Advertised `max_tokens` and individual supported `capabilities.effort` levels map to the shared parameter controls; missing capabilities remain unsupported. Before each move, [Get a Model](https://platform.claude.com/docs/en/api/models/retrieve) checks capabilities using that request's key, including alias resolution, without retaining another account's catalog. This adds a metadata request per attempt and allows persisted games to run after a server restart.

The Models API has no temperature flag. `anthropic-models.ts` conservatively advertises 0–1 temperature only for the verified Haiku 4.5 and Sonnet 4.5 aliases and dated snapshots; it never uses those IDs to restrict availability. Other models omit temperature because newer models reject it and the shared shape cannot express thinking-dependent support. Extend these exceptions only after verifying exact IDs against official documentation. Sources checked 2026-09-06: [Messages parameters](https://platform.claude.com/docs/en/api/messages/create), [model IDs and aliases](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions), and [Haiku migration](https://platform.claude.com/docs/en/models/haiku-4-5/migration-guide).

Each [Messages request](https://platform.claude.com/docs/en/api/messages/create) sends the common instruction as `system` and canonical context as one user message, with no tools, prior conversation, or explicit prompt caching. `max_tokens` is required: absent an effective user value, the adapter supplies 4,096 capped by the advertised maximum. [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) maps to `output_config.effort`; it works with the model's default thinking behavior without a fabricated thinking budget. Models advertising [Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) receive `output_config.format` with a legal-UCI enum and optional commentary. Unsupported string-length schema constraints are omitted upstream; the shared validator still enforces 2,000 characters.

Only `end_turn` text blocks without stop details are parsed. Thinking and redacted-thinking blocks are discarded. Refusal, truncation, tool requests, paused generation, and malformed/illegal move content are `model_invalid`; malformed transport envelopes are provider failures. [HTTP errors](https://platform.claude.com/docs/en/api/errors) map 401/403 to auth, 402/429 to quota, 408/504 to timeout, and other statuses (including 400 and 529) to unavailability, without reading upstream error messages. All provider failures use the existing pause policy.

Latency includes metadata, generation, and body consumption. Only validated `request-id` headers enter telemetry. Reported `input_tokens` and `output_tokens` are validated independently. When [cache counts](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance) are present, input usage sums the fully reported uncached/create/read components; an incomplete, invalid, or overflowing breakdown makes input usage unavailable. Output usage already includes thinking. Anthropic does not report total tokens, so `totalTokens` remains null; cost estimates and cache/thinking breakdown fields remain outside this adapter's shared telemetry. Credential echoes in retained fields are rejected.

## Google adapter

`createGoogleProvider` is registered in the normal server and uses native server-side `fetch` against `https://generativelanguage.googleapis.com/v1beta`. [Authentication](https://ai.google.dev/gemini-api/docs/api-key) uses only the current operation's `x-goog-api-key` header. Each exchange rejects redirects, honors cancellation through body consumption, and has a 120-second timeout. There are no startup calls, environment credentials, automatic retries, or retained conversation state. Automated tests inject mocked HTTP and a clock.

[Models discovery](https://ai.google.dev/api/models) follows `nextPageToken` with 1,000-item pages, rejecting duplicate resource names, cursor loops, more than 2,000 entries, or more than 20 pages. IDs retain the provider's `models/...` resource name; display names fall back to that name. Only entries advertising `generateContent` are eligible. This excludes embedding, prediction, and Live-only models, but does not guarantee that every listed model can produce a chess move. Temperature and output-token limits come from metadata. Each move retrieves that model's metadata with the current key, verifies its identity and generation method, and resolves parameters without requiring a warm catalog.

`google-models.ts` supplements exact documented IDs with [thinking levels](https://ai.google.dev/gemini-api/docs/generate-content/thinking) and [structured-output support](https://ai.google.dev/gemini-api/docs/generate-content/structured-output). It never supplies availability or infers optional capabilities from prefixes, aliases, or the `thinking` flag alone. Extend this metadata only after checking the exact model's official documentation. Gemini 3 effort maps to `thinkingConfig.thinkingLevel`; Gemini 2.5 uses token budgets, which the shared effort control does not approximate. Unsupported parameters are omitted, supported out-of-range values are rejected, and omitted controls use provider defaults.

The stateless [GenerateContent API](https://ai.google.dev/api/generate-content) receives the unchanged common instruction and canonical context as user text parts, allowing models without system-instruction support. Verified models receive `responseFormat.text` JSON Schema with the legal UCI enum and optional commentary. Only one naturally stopped candidate's text is parsed; thought parts and signatures are discarded. Missing, blocked, truncated, tool/media, ambiguous, or invalid move output is `model_invalid`. Malformed transport envelopes and incompatible metadata are operational failures. HTTP 401/403 map to auth, 429 to quota, 408/504 to timeout, and other errors to unavailability; typed [Google API-key errors](https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto) also map HTTP 400 to auth. No raw diagnostics are retained.

Latency includes metadata, generation, and body consumption. `promptTokenCount`, `candidatesTokenCount`, and `totalTokenCount` map independently to input, output, and total usage; missing/invalid counts stay null. Cached input is already included in prompt usage, while total usage also includes thoughts, so total need not equal input plus candidate output. No missing counts or prices are inferred. Only validated response IDs enter telemetry, and credential echoes in retained fields are rejected.

## OpenRouter adapter

`createOpenRouterProvider` is registered in the normal server and uses native server-side `fetch` against `https://openrouter.ai/api/v1`. Bearer authentication uses only the current operation's key. Exchanges reject redirects, honor cancellation through body consumption, and have a 120-second transport timeout. There are no startup calls, environment credentials, retained conversations, or adapter retries. Automated tests inject mocked HTTP and a clock.

[Discovery](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) fetches the full live `/models` catalog without pagination arguments, bounded to 2,000 unique IDs. Namespaced IDs and variant suffixes are preserved verbatim. Explicitly incompatible input/output modalities are excluded; incomplete metadata remains discoverable with only evidenced controls. Temperature requires `supported_parameters` and uses the gateway's 0–2 range. Output-token controls require advertised support and an explicit completion limit, using the smaller reported top-provider/per-request limit and a conservative minimum of 16; context length alone is not an output limit. [Reasoning metadata](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) supplies effort values: omitted effort metadata exposes no selector, explicit `null` allows gateway efforts, and mandatory reasoning excludes `none`. Token-budget-only reasoning is not approximated as effort. No model-name compatibility list is used.

Each move refreshes [single-model metadata](https://openrouter.ai/docs/api/api-reference/models/get-a-model-by-its-slug) at `/model/{author}/{slug}`, including after restart. Alias resolution does not replace the selected ID. Shared configuration validation filters unsupported controls and rejects supported values outside their limits. The [Chat Completions request](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) carries the unchanged common instruction and canonical chess context as user text, supporting models without a system role. It sends `max_completion_tokens` when advertised, otherwise `max_tokens`, and maps effort to `reasoning.effort`. [Routing](https://openrouter.ai/docs/guides/routing/provider-selection) requires parameter support and disables upstream fallback attempts. Remaining-context limits and endpoint availability can still produce operational failures.

Advertised `structured_outputs` enables strict [JSON Schema output](https://openrouter.ai/docs/guides/features/structured-outputs) with the legal UCI enum; `response_format` alone enables JSON mode. Other models receive only the common JSON instruction. Nullable schema commentary normalizes to absence. Only one naturally stopped assistant completion's string/text parts are parsed. Reasoning and routing details are discarded; refusals, truncation, tools/media, missing/ambiguous output, and malformed/illegal moves are `model_invalid`.

[Errors](https://openrouter.ai/docs/api_reference/errors-and-debugging) are checked in HTTP failures, HTTP-200 bodies, and completion choices before accepting output. Typed authentication/permission errors map to auth; payment/rate/token-budget errors to quota; timeouts to timeout; other error envelopes to unavailability. Without recognized typed metadata, numeric 401/403, 402/429, and 408/504 use those respective classifications. Raw messages and metadata are never returned. Latency includes metadata, generation, and body consumption. [Usage](https://openrouter.ai/docs/cookbook/administration/usage-accounting) preserves independently validated prompt/completion/total counts, including zero, without adding cache/reasoning breakdowns or inferring missing totals. Only safe `gen-`/`chatcmpl-` identifiers are retained; credential echoes are rejected. Pricing and costs remain outside the shared adapter contract.

## Provider discovery and session credentials

These endpoints use the same [guest bootstrap and Origin protections](#sandbox-api) as game commands and return `Cache-Control: no-store`:

| Endpoint            | Request                                                                                                                | Success                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /ai/providers` | No query fields                                                                                                        | `200 { providers: [{ id, name }] }`, registered providers only                                  |
| `POST /ai/models`   | `{ "credential": { "provider": "openai", "apiKey": "test-only-placeholder" }, "catalogId"?: "previous-catalog-uuid" }` | `200 { ok: true, value: ModelDescriptor[], catalogId }` or `200 { ok: false, error: { kind } }` |

The credential object is strict: one registered provider and a nonempty key of at most 4,096 printable ASCII characters, without whitespace. Keys are supplied only in JSON bodies, never URLs, headers, cookies, configuration, or saved references. Use HTTPS outside the documented localhost development setup. Missing/invalid credentials receive `400 INVALID_REQUEST`; missing/expired guests receive `401`; wrong/missing POST Origin receives `403`; an unregistered provider receives `404`. Provider authentication, quota, timeout, and unavailability errors retain their enumerated classification without raw messages. Malformed provider results, key echoes, and unexpected exceptions return fixed `500 INTERNAL_SERVER_ERROR` responses. Discovery never creates a game or invokes a move and is not automatically retried.

Call discovery before creating a game. The [bounded guest-specific metadata cache](architecture.md#ai-provider-boundary) supplies authoritative capabilities for creation; clients cannot submit capability claims. Omitted capabilities mean unsupported. Unsupported known parameters are removed; invalid values of supported parameters and unknown fields are rejected. Rediscover after five minutes, cache eviction, a failed refresh, or API restart if creating another game. Existing games use their stored effective configuration. Tests inject adapters through `ai.providers`, with optional `models` reserved for trusted fixtures; normal-server composition uses live discovery.

Keep each success response's `catalogId` with that draft's discovery state and send it inside the corresponding `white`, `black`, or `ai` creation selection. It is a temporary metadata reference, not a credential or a persisted configuration field. Refresh sends the draft's previous reference alongside its credential, invalidating only that catalog even if discovery fails. Expired or evicted references can rediscover; known foreign-guest or wrong-provider references receive `400 INVALID_REQUEST`. Creation rejects unusable references without a fallback. Callers omitting references use the latest-request catalog for the guest/provider; independent seats must supply references. The creation examples below use illustrative UUIDs; replace them with the actual discovery references.

AI-turn requests require the same separate `credential` field, with the current AI seat's provider. Resend the page-memory key with every new HTTP request, including manual retry or a paused step; re-entry is required after refresh or closing the page. The server uses that single key for automatic retries within the same request, never the other color's key. Missing or mismatched credentials cause no reservation or invocation. Duplicate commands with valid transport still return the authorized conflict without calling the provider. Creation, Pause, Resume, Stop, reads, and replay reject credential fields.

The HTTP handler clears its credential field on completion; the registry clears adapter input fields on completion or cancellation, even when an adapter ignores abort. Keys never enter repository arguments, catalog keys/values, telemetry, logs, errors, or responses. Adapters must not keep their own copies. Automated tests use mocks only:

```text
npm exec vitest -- run --config vitest.integration.config.ts apps/api/test/provider-discovery.integration.test.ts
```

## AI setup UI

Open `/` to configure a match. Opening setup establishes the existing guest cookie and checks the registered providers and unfinished-game slot. Model discovery runs only when the user enters a seat's key and selects **Load models**; it never requests an AI move.

AI versus AI is selected initially, with independent White and Black provider, key, searchable model, and advanced parameter controls. Identical providers and models are allowed. AI versus human uses the same controls for one opponent and offers either human color. Switching modes preserves their separate drafts in page memory. Changing a provider clears that seat's key and model configuration; editing its key invalidates its catalog and cancels stale discovery. Loading, classified failure, empty results, missing capabilities, and expired catalogs have separate guidance. Only advertised parameters are shown, with their returned bounds and options; blank values use provider defaults.

Raw keys live separately from configuration in page memory. They are masked initially, can be revealed for the current input, and are cleared by a page refresh or close. No setup state is written to browser storage, URLs, or history state. Keys enter only discovery and AI-turn request bodies. **Start game** validates every AI seat and sends the credential-free [creation contract](#guest-ai-game-api). The server still owns authorization, capability validation, persistence, and the single-game limit.

The setup handoff displays the accepted board and starts [AI-versus-AI playback](#ai-playback-ui) or [AI-versus-human gameplay](#ai-versus-human-ui). **Return to game** reads the saved configuration and full accepted history, then recovers paused. **Enter missing keys** identifies each AI seat and provider; **Use keys for this page** retains validated input only in page memory. Dismissing the dialog leaves its recovery banner. Resume and Next move require every missing key and remain explicit after entry. Uncertain lifecycle commands use the shared synchronization and explicit retry behavior. An access failure clears the private board and offers **Return to setup**, which checks or re-establishes the guest session without retrying the rejected game command.

## AI playback UI

Starting a configured AI-versus-AI match requests the current side's turn with that seat's page-memory credential. Each accepted active response schedules one next turn. **Pause** interrupts automatic progression and sends an authorized pause even during thinking or synchronization. **Resume** resumes active progression; **Next move** requests exactly one paused turn and keeps an unfinished game paused. Confirmed **Stop game** records `aborted`. Controls preserve the accepted position while waiting; lifecycle state and model activity are separate. A provider-error pause, terminal result, transport uncertainty, or page exit stops scheduling.

**Playback speed** selects a presentation gap after each accepted move: 0.5× = 2 seconds, 1× = 1 second, 2× = 0.5 seconds. Changing it reschedules a waiting gap without changing an in-flight request or provider parameters. It is not a chess clock or a promise of provider latency. AI-turn requests explicitly bypass the ordinary ten-second browser timeout, since server-side discovery and invalid-output retries can take longer. The API's provider deadlines still apply, and Pause/Stop/page exit can cancel client consumption.

An uncertain AI response is never resent, even with its old command ID. **Check position** reads the authorized snapshot without starting work. A newer revision may be adopted, with automatic progression still off; an unchanged or unavailable read leaves the turn uncertain. If a rejected lifecycle command's read-back failed, a successful same-version read restores Pause and Stop while preserving AI-turn uncertainty and blocking Resume/Next move. An unresolved lifecycle command still requires its existing command-retry flow. Use **Pause** to invalidate an uncertain turn before **Resume** or **Next move**, or **Stop game** to end the match. If a completion wins the lock before Pause/Stop, the controller follows up against its returned revision, bounded to three lifecycle attempts. Cancellation does not promise to avoid provider cost. Invocation/retry details and provider-specific failure explanations are not exposed by the current snapshot contract.

Pause advances an already-paused AI game's revision even if an uncertain step has not reserved yet. Recovery uses this same command, so no intermediate Resume is needed. Playback stays blocked while recovery is incomplete. An uncertain lifecycle command retains its identifier for **Retry same command**; an accepted active recovery snapshot requires **Retry recovery** before playback becomes available.

Page exit stops timers and request consumption, clears setup/playback keys, and sends a credential-free keepalive Pause. Returning from the back-forward cache also requires key re-entry. An offline event stops progression; reconnecting recovers paused, retaining keys only if the same page remains alive. No turn is automatically resent. Automatic sequences echo the acknowledged API runtime header on subsequent turns; a restarted API rejects the old runtime before provider execution and the controller recovers paused before explicit Resume. Page-exit delivery is best effort; disconnected games are fenced on return even if the exit Pause could not arrive.

Stop confirmation follows the [AI arena confirmation rules](design-system.md#keyboard-and-chess-interaction): moves preserve the dialog, confirmation uses the latest accepted revision, and leaving the unfinished game closes it. Opening the dialog does not halt automatic progression.

## AI versus human UI

Starting an AI-versus-human game faces the board toward the selected human color. Only that seat's active turn permits input, using the existing human move command and server-supplied legal moves. A pending command preserves the accepted position and locks input. Promotion retains the explicit queen/rook/bishop/knight dialog and cancellation behavior. The shared controller requests the opponent's turn after a confirmed human move, or immediately when the human chooses Black, using only the opponent's page-memory credential.

**Pause**, **Resume**, and confirmed **Stop game** share playback's lifecycle and uncertainty handling; speed and single-step controls belong to AI-versus-AI. A rejected, conflicting, or uncertain human response does not launch AI work. An explicit retry preserves the human command's identifier; a successful retry can schedule the opponent, while reconciliation requires explicit Resume. **Resign White** or **Resign Black** appears only for the human seat, requires confirmation, and remains available off-turn or paused. Confirmation follows the latest accepted revision and invalidates a pending AI result.

## Sandbox UI

Open `/sandbox` for the development sandbox. Existing `/?game=...` sandbox links remain supported; new sandbox links retain the `/sandbox` path.

Set `SANDBOX_ENABLED=true` in the local `.env`, apply migrations, and run `npm run dev`. Open `http://localhost:5173` and choose **Start sandbox**. The service readiness indicator checks the database through `/ready`; sandbox availability is determined by creation, so a healthy server can still report that its sandbox is disabled. Enable it on the development server and choose **Retry sandbox**.

One guest controls White and Black. Select a source and a highlighted destination, or use the [board keyboard controls](design-system.md#keyboard-and-chess-interaction). Promotion always requires an explicit piece choice. Flip board changes presentation only. Pieces, turn, result, and SAN history stay unchanged until an authoritative response arrives.

An uncertain submission keeps the original move or lifecycle command in memory. **Check game status** reads the authorized snapshot; **Retry same move** or **Retry same command** reuses the original ID, version, and payload. A same-version GET is still uncertain because the first request could commit later. Rejections also require synchronization before another command. Access loss clears the board, replay, and export text and requires **Start sandbox again**.

Creation updates the private URL to `/?game=<uuid>`. Refresh, reopening that URL, or opening the root page with an existing guest discovers the game without bootstrapping a new guest. Recovery pauses an active game through a versioned command before enabling controls; an already-paused game requires no write. Choose **Resume** explicitly to continue. Concurrent active snapshots are reconciled with at most three pause attempts before **Retry recovery** is offered. An uncertain pause follows the same command retry flow as a move.

**Pause** and **Resume** preserve the position and history. **Abort**, **Resign White**, and **Resign Black** are available while active or paused. The confirmation dialog initially focuses Cancel and explains the outcome. Abortion displays **Game stopped**, keeps result `*`, and releases the unfinished-game slot. Resignation awards the other color the win, including when the resigning color is off-turn.

Completed and aborted games show their result and termination reason, open replay at the final ply, and offer **First**, **Previous**, **Next**, **Last**, and selectable SAN moves. Replay changes only the displayed position. **Copy PGN** and **Download PGN** fetch the private, authorized export endpoint; clipboard failure reveals selectable text. A download contains the canonical UTF-8 text in `neurochess-<uuid>.pgn`. **New game** preserves the previous record and private URL; browser Back can reopen it. Access remains limited to the owning guest until the existing inactivity expiry (24 hours by default). This development flow exposes no recent-games list and performs no retention cleanup.

Visible copy and document metadata come from `apps/web/src/i18n/en.ts`. Use complete messages and named placeholders; keep UCI, SAN, and coordinates unchanged. The i18next resource declaration type-checks keys, falls back to English, and ships no browser-language detection. Inter and Orbitron are bundled locally. API error codes map to catalog entries; do not display server messages or caught exceptions.

Presentation uses Tailwind CSS utilities in JSX. The [design-system tokens](design-system.md#foundations), base layer, and the few custom utilities live in `apps/web/src/styles.css`; shared controls sit under `apps/web/src/ui`. Prettier sorts class names, so run `npm run format` after editing markup. Tests select elements by role, accessible name, or data attribute rather than by class.

## Sandbox API

Set `NODE_ENV=development` and `SANDBOX_ENABLED=true` in the local `.env`, apply migrations, and start the API. Production configuration rejects enablement; disabled servers also reject access to already-persisted sandbox games. The [web sandbox](#sandbox-ui) uses these endpoints unchanged.

| Endpoint                        | Request                                                        | Success                                            |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `POST /guest-session`           | `{}`                                                           | `200 { "status": "ready" }` plus guest cookie      |
| `POST /sandbox/games`           | `{}`                                                           | `201` standard-position active snapshot, version 0 |
| `GET /sandbox/games/unfinished` | No query fields                                                | `200 { snapshot }`, unfinished game or `null`      |
| `GET /games/:gameId`            | UUID parameter, no query fields                                | `200` current authorized snapshot                  |
| `POST /games/:gameId/moves`     | `{ gameId, move, expectedVersion, commandId }`                 | `200` accepted snapshot                            |
| `POST /games/:gameId/lifecycle` | `{ gameId, action, expectedVersion, commandId, losingColor? }` | `200` accepted snapshot                            |
| `GET /games/:gameId/replay`     | UUID parameter, no query fields                                | `200 { snapshot, initialFen }`, terminal only      |
| `GET /games/:gameId/pgn`        | UUID parameter, no query fields                                | `200 { gameId, version, pgn }`, terminal only      |

Lifecycle actions are `pause`, `resume`, `abort`, and `resign`. Only resignation accepts and requires `losingColor` (`white` or `black`). Control commands require ownership; resignation requires authority over the chosen human seat. Only the enabled development sandbox grants its owner authority over both human seats. Discovery never creates a guest; a `401` discovery response tells the browser to show the entry screen. All reads preserve lifecycle and verify complete persisted history and projections.

Bootstrap once and await the cookie before issuing game requests; clients must coordinate first-use bootstrap instead of racing cookie-less initializations. Missing, invalid, or expired cookies on game requests return `401`, with no implicit replacement. Bootstrap alone can replace an expired session; replacement never recovers that session's old games.

Browser requests use `credentials: "include"`. All POSTs require JSON and an `Origin` header exactly equal to `WEB_ORIGIN`, including command-line clients. Use `localhost` consistently for the web and API origins during HTTP development: supported browsers allow Secure cookies on localhost. Non-localhost access requires HTTPS; there is no insecure-cookie override. A cookie jar contains a bearer credential: do not print, commit, or share its contents.

PowerShell example (with `curl.exe`; retain the temporary jar only while continuing this CLI session):

```powershell
$guestCookieJar = Join-Path ([IO.Path]::GetTempPath()) ("neurochess-" + [guid]::NewGuid() + ".cookies")
$headers = @("-H", "Origin: http://localhost:5173", "-H", "Content-Type: application/json")
curl.exe -sS -c $guestCookieJar @headers --data "{}" http://localhost:3001/guest-session | Out-Null
$game = curl.exe -sS -b $guestCookieJar -c $guestCookieJar @headers --data "{}" http://localhost:3001/sandbox/games | ConvertFrom-Json
$move = @{ gameId = $game.gameId; move = "e2e4"; expectedVersion = $game.version; commandId = [guid]::NewGuid().ToString() } | ConvertTo-Json -Compress
$move | curl.exe -sS -b $guestCookieJar -c $guestCookieJar @headers --data-binary "@-" "http://localhost:3001/games/$($game.gameId)/moves"
curl.exe -sS -b $guestCookieJar -c $guestCookieJar "http://localhost:3001/games/$($game.gameId)"
# When finished with this CLI identity:
Remove-Item -LiteralPath $guestCookieJar
```

Use a new command UUID for each move or lifecycle action and reuse the identical command for retries. The body game ID must match the path. After read authorization, stale/future versions and duplicate accepted IDs (including changed payloads or command kinds) return `409 GAME_CONFLICT` with `currentSnapshot`. An occupied active/paused slot returns the same authorized conflict envelope. Refresh client state from that snapshot; never automatically apply a stale move or user action to a new version. Versions advance once per accepted command, including the terminal command; lifecycle commands add no move. A duplicate terminal command still returns a conflict snapshot; a fresh terminal or paused move returns `409 INVALID_GAME_STATE`. Illegal moves return `422`; malformed requests return `400`.

Requests cannot select FEN, history, owner, seat, public mode, or sandbox authority; unknown body/query fields are rejected. Missing or expired sessions receive `401`; inaccessible games receive `404` without snapshots. Replay and export reject unfinished games with `409 INVALID_GAME_STATE`. Completed and aborted records remain private and readable until guest access expires. Pausing occurs only through an authorized POST, never as a side effect of a read.

## Guest AI game API

These routes reuse [guest bootstrap, cookies, Origin checks, private reads, and command semantics](#sandbox-api), without requiring sandbox enablement:

| Endpoint                      | Request                                                                    | Success                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /ai/games`              | AI configuration described below                                           | `201` standard-position active snapshot, version 0                                                  |
| `GET /ai/games/unfinished`    | No query fields                                                            | `200 { snapshot }`, owned unfinished AI game or `null`                                              |
| `GET /ai/games/:gameId`       | UUID parameter, no query fields                                            | `200 { snapshot, configuration }`, owner-only accepted history and saved effective AI configuration |
| `POST /games/:gameId/ai-turn` | `{ gameId, expectedVersion, commandId, credential: { provider, apiKey } }` | `200` snapshot after one active turn or paused step                                                 |

The private AI-game read returns the mode-specific configuration below without `catalogId`; it includes no keys, internal identities, reservations, or telemetry. Reads do not pause or start work and remain usable without provider catalogs after a restart.

Game API responses expose a UUID `x-neurochess-ai-runtime` header through CORS. Browsers acknowledge it on validated session/game reads, explicit lifecycle controls, and AI responses, then echo it on subsequent AI-turn POSTs. A mismatch returns an authorized `GAME_CONFLICT` before reservation; it does not repeat a provider call. Direct explicit command clients may omit the header. This value is not an authentication credential; guest cookies and normal ownership checks remain mandatory. See [ADR-0011](decisions/0011-ai-page-recovery.md).

Creation accepts exactly one of:

```json
{
  "mode": "ai_vs_ai",
  "white": {
    "provider": "openai",
    "modelId": "fixture-model",
    "parameters": { "temperature": 0 },
    "catalogId": "30000000-0000-4000-8000-000000000001"
  },
  "black": {
    "provider": "openai",
    "modelId": "fixture-model",
    "parameters": { "temperature": 1 },
    "catalogId": "30000000-0000-4000-8000-000000000002"
  }
}
```

```json
{
  "mode": "ai_vs_human",
  "humanColor": "black",
  "ai": {
    "provider": "openai",
    "modelId": "fixture-model",
    "parameters": {},
    "catalogId": "30000000-0000-4000-8000-000000000003"
  }
}
```

`fixture-model` is a test fixture, not a production model. `createGameService` accepts an optional `ai` composition containing provider registrations; tests supply `createScriptedMockProvider` or an adapter with mocked HTTP. Creation resolves supported parameters from [discovered metadata or trusted test fixtures](#provider-discovery-and-session-credentials) before persistence. Creation or a fresh AI turn requiring an unregistered adapter returns `404 NOT_FOUND`. Creation rejects credentials; all game requests reject client capabilities, FEN, prompts, seat/owner identities, execution IDs, and lease settings. AI-turn transport separates its credential from the unchanged internal command schema.

Both AI modes and the sandbox share the single active/paused slot. AI-versus-human assigns only the chosen human seat to the guest; ownership cannot move or resign an AI seat. Existing snapshot, lifecycle, terminal replay, and PGN routes retain their private authorization. Unfinished-game discovery excludes sandbox/human-room games and never changes lifecycle, allocates a guest, or calls an adapter. Recovery requires the ordinary authorized pause command, then an explicit step or resume.

The same AI-turn body requests **Next move** from a paused game. It is allowed only on an AI seat's turn and leaves an unfinished game paused, including while waiting for the provider. A terminal move or technical loss completes the game. **Pause**, **Resume**, and **Stop** use the existing lifecycle route with actions `pause`, `resume`, and `abort`; Stop records `aborted` with result `*`. Resume changes lifecycle without calling a provider. Pause on an already-paused AI game is accepted only when it has an outstanding reservation to cancel or abandon, advancing the revision once; otherwise it returns `INVALID_GAME_STATE`.

The server derives the current AI seat and full chess context from verified history. It reserves the command and records a pending invocation in a short transaction before calling the adapter outside that transaction. A live request renews its server-controlled lease. Finalization rechecks access, position, execution ownership, and lease; it validates the move through the deterministic aggregate and atomically records the outcome, move, shared receipt, and new revision. One request executes one turn, including at most two model-invalid retries; it never starts the next side's turn. A third invalid response commits a technical loss. A classified provider failure commits a pause without an automatic retry. For **Retry**, submit a fresh command ID and the paused snapshot's version to `ai-turn`, or explicitly resume before requesting a fresh active turn. Provider failures, interruptions, and lifecycle changes preserve the current turn's recorded invalid-output count; only an accepted move resets it. Retrying an old ID remains a conflict and never calls the provider again. Invocation telemetry remains internal; the response uses the existing snapshot schema.

Duplicate IDs, competing requests, stale revisions, expired reservations, and late results return `409 GAME_CONFLICT` with an authorized current snapshot. A same-version conflict does not prove the original request finished. No duplicate may repeat the adapter call. Pause, resume, abort, or human resignation can invalidate a pending turn without waiting for the adapter. An HTTP disconnect stops lease renewal and signals cancellation; an uncertain reservation requires explicit Pause (even when already paused) and a new command, never automatic takeover. The user may then step or resume. Unexpected adapter failures return a fixed safe `500` and require the same recovery; no raw provider object is logged or returned.

Focused verification uses the actual service and disposable PostgreSQL database with mocks only:

```text
npm exec vitest -- run --config vitest.integration.config.ts apps/api/test/ai-games.integration.test.ts apps/api/test/ai-lifecycle.integration.test.ts
```

## PostgreSQL integration tests

Add `TEST_DATABASE_URL` from `.env.example` if updating an existing `.env`, then run:

```text
npm run infra:test:up
npm run test:integration
npm run verify
```

The test service binds loopback port 5433 and uses tmpfs instead of the development volume. Its data is disposable when the container stops. Tests require an explicit PostgreSQL URL whose database name ends in `_test` and reject connection-level `options`; they never fall back to `DATABASE_URL`. Global setup applies reviewed migrations twice. Fixtures use unique guest IDs and cleanup deletes only those guests' games and sessions, not whole tables. Concurrent scenarios use independent pools/API instances, and rollback tests fail after an actual SQL insert. Tests never silently skip when PostgreSQL is unavailable.

CI uses its own ephemeral `neurochess_test` database and runs integration tests through `npm test`. Unit tests and architecture checks remain runnable without PostgreSQL. Keep `TEST_DATABASE_URL` pointed only at a dedicated disposable database, never shared or production data.

## Browser tests

After installing dependencies, prepare Chromium and the disposable database:

```text
npm exec playwright -- install chromium
npm run infra:test:up
npm run verify
npm run test:e2e
```

Playwright starts the actual Fastify guest/game services and Vite app at `http://localhost:3101` and `http://localhost:5174`. These ports must be free; the suite refuses to reuse existing servers. The test entrypoint validates `TEST_DATABASE_URL` with the same `_test`/no-options guard as integration tests before opening a connection or applying reviewed migrations. It never falls back to `DATABASE_URL`. No arbitrary-position endpoint or mocked gameplay API is used.

AI browser tests inject mock provider adapters into that service. Setup fixtures hold the first AI turn until cancellation; playback fixtures return legal moves from the standard position, including an eleven-second delayed response. They cover independent and identical-model configuration, both human colors, supported parameters, validation, discovery states, real creation/paused recovery/stop, key loss on refresh, and absence of keys or setup writes in browser storage. Playback coverage adds automatic completion, pause during thinking, paused stepping, resume, presentation speed, Stop confirmation across accepted moves, and stopping progression. AI-versus-human coverage completes games with either human color, checks keyboard/touch seat interaction and orientation, and exercises explicit underpromotion and resignation during thinking. Recovery regressions intercept a turn before reservation and optionally fail its lifecycle read-back; subsequent successful reads and lifecycle commands use the real API and database. Recovery coverage also restores both modes through key loss and explicit continuation, preserves repetition history, closes a page during a call, disconnects offline, and leaves between turns. Run these with `npm run test:e2e -- test/e2e/ai-setup.spec.ts test/e2e/ai-playback.spec.ts test/e2e/ai-human.spec.ts test/e2e/ai-recovery.spec.ts`. Automated providers never make paid calls.

Desktop Chromium and a Chromium mobile-touch context create a game, play part of Fool's Mate, refresh into paused recovery, explicitly resume, complete checkmate, navigate every replay position, copy/download PGN, start another game, and reopen the previous private URL. Downloaded text must exactly equal persisted PGN; clipboard readback normalizes Windows CRLF conversion while the client writes the canonical text unchanged. Further cases cover both resignation colors, neutral abortion, isolated-guest access denial, root-page recovery, and White knight/Black rook underpromotions through legal moves from the standard position.

Accessibility and layout checks cover keyboard directions and Tab order, modal focus containment/return, 44px controls, reduced motion, 320/390/768/1024/1440px layouts, 200% text, 50% expanded test resources, stable move-history placement during commands, and axe checks. Expansion is injected by the test into the dev module; it is not a product locale or flag.

Each browser context has an isolated guest. Cleanup deletes only guests/games created by that test; the server also tracks guests it created for graceful shutdown. Screenshots and failure context go to `neurochess-playwright-results` in the OS temporary directory, outside the repository. Traces, HARs, and videos are disabled so guest cookie headers are not recorded. CI installs Chromium and runs this suite after the full build in `npm run verify`. The separate `npm run smoke` checks built-service startup.

Automated checks do not certify screen-reader behavior or every browser engine. Consult the [current validation limits](design-system/validation.md) for remaining coverage gaps. Report each run in the change summary, PR, or CI; update that document only when a gap changes.

## Migrations

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. Better Auth schema generation will feed this same migration history when authentication is implemented.

Migration `0002_game_command_receipts.sql` creates the shared accepted-command receipts and backfills existing moves. Stop old API writers before applying it, then start the API version that writes receipts for every move and lifecycle action. See [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md). Integration tests exercise this backfill on a populated prior schema, receipt uniqueness, cascading deletion, and atomic rollback.

Migration `0003_ai_turn_persistence.sql` adds game modes, independent AI seat configuration, normalized invocation attempts, and leased turn reservations. Existing human sandbox records retain their identity, authority, history, receipts, and unfinished-game slot; their mode defaults to `human_vs_human`. Unconfigured legacy AI placeholder seats are rejected, not assigned a fabricated provider/model. The reviewed SQL creates composite unique indexes before their referencing foreign keys. Stop old writers while migrating and restart with the reservation-aware repository. Run `npm run db:check` and `npm run test:integration` to verify metadata, populated-schema upgrades, migration/write rollback, constraints, and concurrent ownership/recovery across independent pools.

The internal AI persistence operations and caller responsibilities are defined in [ADR-0009](decisions/0009-ai-turn-persistence.md) and its [stepping/retry extension](decisions/0010-ai-paused-stepping-and-retry-accounting.md). They run inside the existing game transaction interface; provider calls must run outside it. The [guest AI service](#guest-ai-game-api) composes these operations without another schema migration. Use only normalized mock outcomes in automated persistence tests, and never pass credentials or raw provider objects into repository calls.

## Logging and errors

The API logger omits request bodies, retains only method/path/request ID for requests, strips URL queries, and recursively redacts credential-like object fields. Raw exceptions are reduced to a safe name and non-secret code before serialization; the error serializer preserves only those diagnostic fields when it receives an already-sanitized record.

Idle PostgreSQL pool errors write a fixed, credential-free diagnostic to stderr without terminating the API. The pool remains available for new connections, and `/ready` checks current database availability on every request, returning `503` when its query fails.

System errors retain `code`, `message`, and `requestId`. Structured game errors use the same envelope with enumerated codes; only `GAME_CONFLICT` additionally requires an already-authorized `currentSnapshot`. Messages come from the API's English error catalog, never domain/engine exceptions. Domain failures expose codes and, for an invalid history entry, its one-based ply only. No error accepts arbitrary details or raw exception payloads. Guest/game responses are `no-store`, and the raw guest token appears only in its cookie. Corrupted persisted history or projections yield a safe `500` and leave game data unchanged. Add logging and error tests whenever a new boundary accepts credentials or provider payloads.
