# Phase 2 PR plan

This is a proposed sequence of implementation slices, not a list of existing GitHub PRs. Product and architecture contracts remain authoritative; implementation status belongs in the [roadmap](roadmap.md#phase-2--ai-arena-core).

Land these PRs in order, starting each from the branch containing the previous merged PR. The first four establish the authoritative path with mocks before real providers are introduced. Each provider then gets a separate adapter PR. Setup components precede the public game controller so neither UI PR needs to rebuild the presentation foundation.

## Sequence

| ID    | PR scope                                            | Reviewable outcome                                                                                                                |
| ----- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P2-01 | AI game configuration and provider contracts        | Ordinary AI games can be represented, created through the service, and restored with private, credential-free seat configuration. |
| P2-02 | One authoritative AI turn with a mock adapter       | A server-built prompt produces at most one accepted legal move despite duplicate or stale requests.                               |
| P2-03 | Failure policy and invocation persistence           | Invalid-output retries, technical losses, provider pauses, and attempt metadata survive recovery.                                 |
| P2-04 | Session-only credentials and model discovery        | Validated backend discovery and turn APIs use request-scoped keys and capability-aware parameters.                                |
| P2-05 | OpenAI adapter                                      | OpenAI passes the shared provider contract suite.                                                                                 |
| P2-06 | Anthropic adapter                                   | Anthropic passes the same suite.                                                                                                  |
| P2-07 | Google adapter                                      | Google passes the same suite.                                                                                                     |
| P2-08 | OpenRouter adapter                                  | OpenRouter passes the same suite.                                                                                                 |
| P2-09 | Independent seat setup UI                           | Accessible configuration components connect discovery, parameters, and page-memory keys.                                          |
| P2-10 | AI-versus-AI controller and recovery                | The public Arena can run, pause, step, resume, stop, and recover an AI match.                                                     |
| P2-11 | AI-versus-human mode                                | A guest can play either color through the existing human-command authority.                                                       |
| P2-12 | Basic telemetry/replay views and Phase 2 acceptance | Both AI modes have inspectable outcomes and the provider-combination acceptance matrix is covered.                                |

P2-02 and P2-10 deserve particular review attention: reservation correctness and browser absence cannot be established by disabling a button alone.

## Working agreement for every PR

- Read `AGENTS.md` and the task-relevant canonical sections, following accepted ADRs. Use the existing [command model](architecture.md#game-command-model), [provider boundary](architecture.md#ai-provider-boundary), and [credential lifecycle](architecture.md#credential-lifecycle). This plan does not authorize changing their requirements.
- Reuse the existing game service, PostgreSQL ownership/command machinery, chess aggregate, and arena presentation boundary. Introduce AI-specific services/controllers where responsibilities differ; avoid a wholesale Sandbox refactor.
- Keep each PR independently buildable and tested. Test adapters are dependency-injected fixtures, never a public provider option or a production fallback. Do not expose a user journey before its required lifecycle and credential protections work.
- Add behavior tests in the PR introducing the behavior. The final PR fills integration gaps; it does not defer legality, authorization, concurrency, or redaction tests.
- Generate and review forward Drizzle migrations when needed. Test existing Sandbox data as well as new AI records; preserve the single active/paused slot across modes.
- Run the smallest relevant checks while iterating, then `npm run verify` before handoff. It includes formatting, lint, typecheck, unit/integration/architecture tests, and build. Use the documented disposable PostgreSQL database. Run `npm run db:check` for migration changes and `npm run test:e2e` for changes affecting browser flows.
- Use current official provider documentation when implementing an adapter. Keep ordinary tests deterministic and free of paid calls. Report separately any explicitly authorized live smoke checks and any untested live behavior.
- Update canonical docs only for changed contracts/instructions or corrected claims. Update the roadmap at milestones; do not add completion tracking here or verification logs to the design validation document.
- Report what changed, tests actually run, limitations, and any prerequisite the next PR needs. Implement only the selected PR.

## P2-01 — AI game configuration and provider contracts

**Scope:** `packages/contracts`, database schema/repositories, and API game/provider interfaces.

- Define strict runtime schemas for the two AI modes, human/AI seats, provider/model selection, capability descriptors, supported parameters, normalized move output, safe provider failures, and nullable usage. Keep provider SDK types out of shared contracts and the chess package.
- Add a server-side adapter interface and a reusable scripted test adapter. Keep commentary optional and UCI canonical.
- Persist ordinary game mode and independent AI seat configuration using typed relational fields and bounded parameter metadata. Preserve the internal Sandbox marker and define a safe migration/backfill for existing records. Credentials are not configuration fields stored in game records.
- Extend service creation, authorized reads, unfinished-game discovery, and configuration restoration for ordinary AI games. Support two AI seats or one guest-assigned human seat; allow identical providers/models on both colors. Wire the new HTTP surface in P2-04 after boundary protections exist.

**Acceptance:** Schema and PostgreSQL tests cover malformed configurations, seat identity, round trips, existing Sandbox restoration, private reads, and concurrent creation across modes. A guest never gains permission to move an AI seat or control both ordinary human seats. No provider call or public UI is needed yet.

## P2-02 — One authoritative AI turn with a mock adapter

**Scope:** AI execution through the existing command service, with database-backed reservations.

- Authorize the owner, AI seat, lifecycle, and expected revision before dispatch. Construct FEN, complete identity/commentary-free PGN, color/side to move, and legal UCI moves from reconstructed server state. Never accept a client-supplied prompt, position, legal list, or opponent context.
- Reserve the turn in a short transaction, call the injected adapter outside the transaction, validate the output and legal move, then recheck authority/reservation/version and commit atomically. Use the existing deterministic move/adjudication path.
- Distinguish an in-flight reservation from an accepted `game_commands` receipt. Deduplicate concurrent dispatches, preserve accepted-command identity across command kinds, and invalidate late results after pause, abort, resignation, or another accepted revision.
- Define safe cleanup for failed/interrupted execution and recovery of orphaned reservations. Record the reservation/receipt and crash-recovery design in a new ADR before relying on it. Do not claim exactly-once provider billing across process crashes; an uncertain upstream request must not silently trigger another call.

**Acceptance:** PostgreSQL tests with independent API instances and a controllable fake adapter prove duplicate suppression, stale-result rejection, authorization rechecks, rollback, restart recovery, and full-history adjudication. A mocked AI match can reach a natural result through the real service. Invalid output is never committed; P2-03 completes its product failure policy before live adapters become available.

## P2-03 — Failure policy and invocation persistence

**Scope:** Retry classification, trusted technical-loss handling, and operational records.

- Apply the [failure policy](product.md#failure-policy): at most three model-output attempts, with the third invalid result producing a technical loss. A missing commentary field remains valid. Provider/auth/quota/network/timeout failures pause for user-directed retry and do not increment the invalid-output count.
- Preserve the logical turn and invalid-output budget across duplicate requests, provider failures, and explicit recovery/retry of that same turn. A refresh or transport retry must not create a new automatic retry budget.
- Persist normalized invocation attempts, provider/model, effective parameters, outcome, safe error code, measured duration, and reported input/output/total tokens. Associate successful commentary and attempts with the accepted move; retain failed attempts even when no move is committed. Keep absent usage distinct from zero.
- Make loss, pause, and final move outcomes atomic with their required command/attempt records. Expose private normalized attempt data through service/read contracts for later UI use. Do not persist raw provider responses, secret-bearing exceptions, or prompts by default.

**Acceptance:** Cover invalid-invalid-valid, three invalid results, missing commentary, every provider-error category, an invalid result followed by a provider failure and manual retry, unknown usage, and late failure after Stop. Duplicate requests cannot duplicate attempts or terminal transitions; recovery retains the counters and safe records.

## P2-04 — Session-only credentials and model discovery

**Scope:** Fastify provider/AI-game routes, web API client, and page-memory credential handling, initially tested with injected providers.

- Reuse explicit guest bootstrap, exact-Origin checks, authorization, no-store responses, and strict request/response schemas. Loading the page must not silently create a guest. Provider keys travel only in the body of operations that need them, over the deployment's HTTPS boundary; never in URLs or game configuration.
- Keep keys only in page memory and the backend request performing discovery or inference. Do not retain a key on an adapter singleton, in a reservation, in retry receipts, in caches, or in persistent browser state. Saved credentials belong to Phase 3.
- Implement live-discovery plumbing and bounded capability descriptors. Validate selected parameters server-side, omit unsupported fields, and record the effective parameters actually sent. Unknown capabilities must not enable speculative controls; dynamic provider discovery cannot be replaced by a static model allowlist.
- Keep any discovery caching short-lived and prevent results tied to one credential/account from leaking into another session. Use the shared adapter fixtures to test authentication, empty catalogs, invalid upstream data, changed capabilities, and discovery failures.
- Extend redaction tests across body validation, adapter errors, logs, responses, and stored records. Drop raw upstream exception text rather than trying to render it safely. Give AI requests an explicit cancellation/transport policy instead of inheriting the Sandbox client's ten-second timeout; operational timeouts pause and never become a chess time control.

**Acceptance:** Mock HTTP integration tests prove the full discovery/create/turn path and reject unauthorized access before upstream calls. Sentinel keys are absent from logs, database records, response payloads, URLs, and browser persistence. Provider failure codes reach the localization boundary without raw exception text.

## P2-05 through P2-08 — One provider per PR

Implement these independently in the recommended order:

| ID    | Provider   | Required adapter-specific review                                                                            |
| ----- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| P2-05 | OpenAI     | Discovery, callable-model capabilities, request parameters, response extraction, and usage normalization.   |
| P2-06 | Anthropic  | Discovery/capabilities and provider-specific content, output-limit, usage, and error handling.              |
| P2-07 | Google     | Discovery and supported generation methods, parameter translation, response candidates, and usage handling. |
| P2-08 | OpenRouter | Routed model identifiers, advertised capabilities, usage availability, and upstream-versus-router failures. |

**Scope for each:** Add one adapter under the API provider boundary and register it. Verify API/SDK behavior against current official documentation in that PR; this plan intentionally fixes neither model IDs nor an evolving parameter matrix.

**Acceptance for each:** Run the same contract suite through that provider's HTTP/SDK boundary, with realistic sanitized fixtures:

- list models, including pagination where relevant, and normalize capability metadata;
- send only supported parameters and the canonical fair chess context;
- return a legal UCI move with and without commentary;
- classify malformed output, refusal/truncation, unsupported-model responses, authentication, quota/rate limits, network errors, and timeouts explicitly under the common policy;
- preserve missing usage and reject malformed upstream payloads;
- propagate cancellation and sanitize errors, identifiers, and bounded metadata;
- disable implicit SDK/network retries that would bypass user-directed provider-error recovery or multiply the runner's invalid-output attempts.

Every adapter must also execute a turn through the real orchestration service using mocked upstream transport. Changes to the shared contract require regression tests for adapters already merged. Do not add a provider-specific game loop, UI form, or model allowlist. Record live smoke evidence only if it was separately authorized and actually run.

## P2-09 — Independent seat setup UI

**Scope:** AI setup components and an Arena-specific presentation adapter using the existing shell, board, panels, semantic theme, and localization layer.

- Build White and Black configuration with provider selection, a dynamically loaded model list, capability-aware parameters, and session-only key entry. Support identical models with independent settings and keys; clear stale model/parameter selections when their provider or capabilities change.
- Explain page-memory credentials using the [design contract](design-system.md#credential-and-telemetry-rules). Include loading, empty, unavailable, invalid-key, and existing-game conflict states. Human-seat configuration will be enabled in P2-11.
- Connect components to the validated API client and creation handoff. Preserve the [arena presentation boundary](architecture.md#sandbox-web-client): shared presentation does not import Sandbox controllers or provider clients.
- Use the existing [setup concepts](design-system/concepts/README.md#setup) and current shared arena styling. Implement and verify the components before P2-10 connects the complete public Start flow to `/`; do not launch an incomplete game journey.

**Acceptance:** Component/API tests cover seat independence, stale discovery responses, field changes, capability filtering, in-memory key handling, and start readiness. Check keyboard use, labels, focus, expanded text, and mobile layout. Preserve the development-only Sandbox navigation and production boundary.

## P2-10 — AI-versus-AI controller, controls, and recovery

**Scope:** Public Arena integration, one-at-a-time browser orchestration, and server-enforced controller presence.

- Connect setup to `/`, authorized game URLs/discovery, and the live arena. The browser requests the next AI turn only after accepting the previous complete response; it never advances a board speculatively. Handle conflicts with an existing unfinished game, including Sandbox in development.
- Add Pause, Resume, Next move, speed, and confirmed Stop. Speed controls the delay between turns. Stop uses `aborted`. Next move is one authorized versioned operation while paused, accepts at most one move, and returns paused unless that move ends the game. Do not expose playable moves in ordinary paused snapshots or emulate the step through loosely coordinated Resume/Move/Pause requests.
- Keep Pause/Stop usable while a provider call is pending. They must invalidate the reservation when accepted; a delayed result cannot revive a stopped or paused game. Preserve an uncertain command's identity and block new turn dispatch until it is resolved.
- Define and document controller presence, including competing tabs, network loss, API restart, and loss between turns. A bounded authenticated heartbeat/lease is a suitable starting design; select the minimal mechanism and record consequential decisions in an ADR. Fence old controllers and perform an authoritative pause when presence is lost. An unload handler alone is insufficient. Presence timeouts are connection handling, not chess clocks or limits on model thinking.
- Stop automatic requests on navigation/close and clear keys on refresh/close. Recover through authorized reads plus explicit versioned pause, preserve full history and seat configuration, and require the missing keys and explicit user action before continuing. Snapshot GETs remain read-only. Implement safe provider-error guidance and user-directed retry.
- Reuse terminal result, replay, and PGN presentation. Both AI seats remain read-only to human move commands; activity and connection descriptions do not add canonical game states.

**Acceptance:** Real API/PostgreSQL browser tests with mocked upstream providers cover a complete match, each control, single-step completion, invalid-output loss, provider pause/retry, duplicate clicks, uncertain acknowledgements, and private replay. Test refresh and tab loss both during a provider call and between calls, competing controllers, stale responses after Stop, and no dispatch before key re-entry plus explicit resume. Cover desktop and mobile. Do not promise that cancellation prevented an upstream charge.

## P2-11 — AI-versus-human mode

**Scope:** Human color selection and turn coordination using the same AI execution/configuration path.

- Assign the guest only to the chosen human seat. If the human chooses Black, AI White makes the opening move. After each accepted human move, request one AI turn; on a human turn, wait for the player's command.
- Reuse the existing server-authorized human move path, keyboard/touch board, promotion selection, and uncertain-command handling. Keep the human's color at the bottom initially and keep inspection available while movement is disabled.
- Expose human resignation only for the human seat, with confirmation, including paused/off-turn cases. Use the existing pause, abort, recovery, retry, result, and replay contracts; require a key only for the AI seat.

**Acceptance:** API tests reject guest attempts to move or resign the AI seat and prove ordinary games cannot inherit Sandbox authority. Desktop/mobile end-to-end tests cover both human colors, AI-first play, promotion, duplicate human commands, provider pause/retry, recovery, resignation, and natural completion. No private rooms or online-human transport is introduced.

## P2-12 — Basic telemetry/replay views and Phase 2 acceptance

**Scope:** Minimal viewer-facing use of P2-03 records and completion of integration coverage.

- Fill the arena's optional commentary, telemetry, and Events slots with normalized data. Show safe retry counts/reasons and the exact missing-commentary fallback. Render commentary as untrusted text, never hidden reasoning or executable markup.
- Associate accepted-move commentary, measured latency, and reported token counts with replay selection. Include failed/retried attempts in clearly labeled operational totals; never label a partial sum as a complete known total or treat missing data as zero.
- Verify private replay and PGN access after completion or abortion and after starting another guest game. Keep PGN canonical and identity/commentary-free so later prompts cannot acquire opponent information from it.
- Run an ordered 4-by-4 AI-versus-AI provider matrix, including same-provider matches, plus each of four providers against both human colors. Use real API/database orchestration with deterministic upstream fixtures, and retain each adapter's contract tests. Distinguish this coverage from current live-provider availability.
- Complete focused cases for independent parameters, technical loss, provider-error pause/manual retry, missing usage, close/refresh/key loss, single-game limits, authorization, and terminal replay. Re-run the existing Sandbox suite. Fill remaining browser-flow gaps rather than duplicating all lower-level tests.

**Acceptance:** Run the full configured verification and desktop/mobile end-to-end suites; review migration metadata and the security-sensitive evidence accumulated across the PRs. Update the roadmap only when the Phase 2 exit condition is supported, and describe any untested live-provider behavior accurately.

Stockfish, evaluation graphs, pricing/estimated-cost calculation, richer analysis views, broad cross-browser certification, and release hardening remain in Phase 5. Accounts, encrypted saved keys, and durable account history remain in Phase 3; private human rooms and their WebSocket protocol remain in Phase 4. Basic Phase 2 visibility should use the data already required by AI orchestration without pulling those later milestones forward.
