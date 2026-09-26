# Architecture

**Status:** Proposed baseline for MVP  
**Last updated:** 2026-09-26

## Architectural drivers

- A server-authoritative chess state prevents clients and models from creating illegal or conflicting moves.
- Four AI providers must behave through one normalized contract while retaining provider-specific capabilities.
- Bring-your-own-key credentials require strict storage, transport, and logging boundaries.
- Human games need realtime updates and reconnection.
- AI games deliberately stop when the controlling browser session is absent, so the MVP does not need a durable background-job platform.
- The stack should remain portable until a hosting platform is selected.

## System context

```mermaid
flowchart LR
    U["User browser"]
    W["React and Vite web app"]
    S["Stockfish Web Worker"]
    A["Fastify API and WebSocket server"]
    D[("PostgreSQL")]
    P["AI provider APIs"]
    O["Google, GitHub and email services"]

    U --> W
    W <--> |"HTTPS and WebSocket"| A
    W <--> |"Position analysis"| S
    A <--> D
    A <--> |"User-authorized requests"| P
    A <--> |"Authentication flows"| O
```

The web application never calls an AI provider directly. The API normalizes model discovery, capabilities, move requests, usage, errors, and redaction.

## Repository shape

The initial implementation is an npm workspaces monorepo:

```text
apps/
  web/          Pages, UI, client state, WebSocket client, Stockfish worker
  api/          HTTP API, WebSocket server, auth, game orchestration, providers
packages/
  chess/        Domain types and deterministic chess helpers
  contracts/    Runtime schemas and shared transport types
  database/     Drizzle schema, migrations, repositories
  config/       Shared TypeScript, lint, and test configuration
docs/           Product, architecture, roadmap, and ADRs
```

Packages expose intentional public entry points. The web application may import shared contracts and chess presentation helpers but not API repositories, provider clients, or credential code.

## Components

### Web application

Responsibilities:

- render the dark, responsive arena UI;
- collect provider/model/parameter configuration;
- hold session-only provider keys in memory;
- initiate exactly one AI turn at a time;
- maintain HTTP and WebSocket session state;
- run Stockfish analysis in a Web Worker without blocking rendering;
- send display-only evaluation results to the API for saved games;
- localize all user-facing text.

The client is not authoritative for legal moves, game results, authorization, participant identity, or room state.

### Fastify API

Recommended modules:

```text
auth          Better Auth integration and account lifecycle
profiles      private username onboarding and provider-avatar preferences
users         deletion and history ownership
credentials   session credential handling and encrypted saved credentials
providers     OpenAI, Anthropic, Google, and OpenRouter adapters
games         game commands, reads, lifecycle, replay, and PGN
chess         server-side legality and result evaluation
rooms         invitation codes, membership, reconnection, and abort
realtime      WebSocket authentication, events, and connection registry
analysis      persisted Stockfish samples and post-game aggregates
```

Fastify route schemas validate external input and serialize explicit response shapes. Domain services do not depend on Fastify request objects.

### PostgreSQL and Drizzle

PostgreSQL is the durable system of record. Drizzle ORM defines the schema in TypeScript and Drizzle Kit produces reviewed SQL migrations. Use the latest stable release line; do not base the MVP on Drizzle v1 beta/RC relations APIs.

Core tables are expected to include:

| Table                  | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Better Auth tables     | users, accounts, sessions, verification records                    |
| `profiles`             | unique username, avatar metadata, preferences                      |
| `provider_credentials` | encrypted key material and provider metadata                       |
| `games`                | mode, state, result, FEN, PGN, ownership, privacy, version         |
| `game_participants`    | human, guest, or AI seat configuration                             |
| `moves`                | canonical move, position, commentary, timing, evaluation           |
| `game_commands`        | accepted command identity, kind, and aggregate revision            |
| `model_invocations`    | attempts, provider/model, parameters, usage, cost estimate, errors |
| `rooms`                | private invitation code, owner, membership, lifecycle              |
| `guest_sessions`       | expiring identity and active-game recovery metadata                |

Stable relational fields stay in typed columns. Bounded provider-specific parameter, usage, and error metadata may use `jsonb`. Provider keys never appear in JSON metadata.

Enforce the [public-mode and independent Sandbox limits](product.md#development-sandbox) with database constraints and an application-level check with a clear conflict response. Every game has exactly one relational owner: `owner_guest_session_id` or `owner_user_id`. A partial unique index on `(owner_guest_session_id, is_sandbox)` reserves each guest's independent slots; a partial unique index on `owner_user_id` reserves one active/paused public game across all sessions of an account. Sandbox requires a guest owner. Human seats reference at most one guest or account; AI seats reference neither. Account foreign keys restrict deletion until application cleanup is implemented. See [ADR-0012](decisions/0012-independent-sandbox-game-slot.md) and [ADR-0013](decisions/0013-principal-and-account-ownership.md).

### Stockfish worker

Stockfish runs inside a browser Web Worker after every accepted move. Analysis is asynchronous and must not block the next visual update. The web app may persist evaluation score, mate distance, depth, and principal variation for replay.

Stockfish data is display and analysis metadata, not authoritative chess state. It is never included in an LLM prompt. Because client-computed analysis is untrusted, it must not later be reused for ratings, prizes, or security-sensitive decisions.

## Game command model

All game mutations are commands against a game version. The server validates:

1. requester identity and participation;
2. current game state;
3. expected side to move;
4. expected game version;
5. move legality;
6. resulting game state and termination.

The server persists the move and updated game state atomically. Duplicate or stale commands return the current state instead of appending another move.

For conflict handling, establish read authorization first, then check the accepted command ID and expected version before fresh-command lifecycle and current-seat checks. This lets an authorized retry return the current snapshot even when the accepted move changed the turn or completed the game.

Reconstruct the chess engine from the ordered, persisted UCI moves starting at the standard initial position. Current FEN alone cannot restore repetition history. Keep FEN, PGN, result, and termination reason consistent with this history; evaluate the [product's automatic draw policy](product.md#automatic-draw-policy) before allowing another turn.

### Deterministic domain and core contracts

`@neurochess/chess` wraps pinned `chess.js` 1.4.0 behind an opaque synchronous aggregate. `createGame()` creates the standard position in `configuring`; callers explicitly start it. Commands return either a defensive `ChessSnapshot` or a code-based domain failure, without transport identifiers, clocks, I/O, display text, or engine objects. Only active games expose playable moves. The internal lifecycle reducer handles start, pause, resume, abort, and completion. Trusted `resignHuman(losingColor)` and `recordTechnicalLoss(losingColor)` hooks require the caller to verify seat type, authorization, and retry policy.

`restoreGame({ moves, lifecycle })` requires the complete ordered UCI history and explicit lifecycle metadata. It replays the same internal move/adjudication path without constructing intermediate snapshots; PGN, legal-move lists, and defensive history copies are projected only when a snapshot is requested. It rejects entries after a terminal outcome and lifecycle metadata that contradicts the replay. Paused, aborted, and non-board completion states are preserved. Session recovery restores the persisted lifecycle before submitting an explicit pause command; domain restoration does not infer browser presence. FEN, SAN, legal moves, and identity/commentary-free PGN are derived, never restored from cached strings. PGN's result header and final marker always reflect the domain result. Unfinished games use `*` with a null reason; aborted games use `*` with reason `aborted`.

Repetition uses occurrence counts keyed by the first four fields of the engine's normalized FEN, including legal en passant availability and excluding move counters. Do not substitute `chess.js` 1.4.0's repetition hash: it retains an en passant target when an adjacent pawn is pinned and cannot capture. A regression fixture demonstrates the resulting missed third occurrence. The adapter counts the initial position and every accepted move, rebuilding counts on restoration. The engine's half-move counter supplies the fifty-move threshold; specific predicates are evaluated in the [product-defined order](product.md#automatic-draw-policy), not through generic `isDraw()` or `isGameOver()`.

`@neurochess/contracts` independently defines strict Zod schemas for bootstrap, creation, route parameters, snapshots, move commands, and errors. Sandbox HTTP creation accepts only `{}`; it grants no sandbox privilege and does not select a public mode. Snapshots add a UUID `gameId` and nonnegative safe-integer `version` to domain data. Move commands contain `gameId`, canonical UCI `move`, `expectedVersion`, and UUID `commandId`. Clients reuse a command ID for retries of the same command. Version is an aggregate revision, not the number of plies: the application layer owns version advancement for persisted state changes, atomic writes, and deduplication. A `GAME_CONFLICT` error carries the current authorized snapshot for stale or duplicate commands; other errors cannot carry snapshots.

The two shared packages remain separate leaves. Their duplicated stable literals, database literals, and snapshot compatibility are checked in the API test suite. Contracts validate wire structure and lifecycle/result combinations, not chess semantics. Arbitrary-FEN fixtures are package-internal, outside production compilation and exports. HTTP orchestration and persistence are consumers of these packages, not dependencies of them.

### Persisted guest commands

Fastify exposes guest bootstrap, sandbox creation/discovery, snapshots, moves, lifecycle commands, replay, and PGN. Routes validate strict request/response schemas and delegate to injected guest and game services. The game service composes the chess aggregate with database-owned repository interfaces; the database package does not import chess or contracts. The [development guide](development.md#sandbox-api) specifies the wire behavior.

PostgreSQL stores normalized `guest_sessions`, `games`, `game_participants`, and `moves`. The server creates an active standard-position game at revision zero, with a human White seat assigned to the owner and an unassigned human Black seat. An internal `is_sandbox` marker and enabled non-production policy are both required for the owner to control both seats. Ordinary-game ownership is not move authority; the current human seat must be assigned to the requester. No ordinary-game creation or joining route is introduced here.

Write transactions use `READ COMMITTED`, locking the guest row before the game row. A partial unique index on owner and Sandbox marker enforces the active/paused slot within each group. Normalized `game_commands` receipts enforce accepted command-ID and revision uniqueness across moves, pause, resume, abort, and human resignation; the forward migration backfills old move receipts. Each successful command commits its receipt, position/result fields, and any move insert together, advancing the aggregate revision once. Lifecycle commands add no move. Completion and abortion release the slot in that transaction. No provider call occurs inside these transactions. See [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md).

Snapshot reads use a read-only `REPEATABLE READ` transaction so history and version come from one database view. The service restores ordered UCI history, checks persisted FEN/PGN and per-move projections, and rejects inconsistencies without repairing data or changing lifecycle. See [ADR-0006](decisions/0006-guest-owned-game-commands.md) for identity, authority, concurrency, and follow-up boundaries.

### Ordinary AI game configuration

`aiGameConfigurationSchema` describes `ai_vs_ai` and `ai_vs_human` with independent `white` and `black` seats. AI seats contain provider, model ID, and a closed parameter object; human seats contain only their type. Creation assigns the owning guest or account to the single human seat, if present. Identical providers/models are allowed. Credentials, identity IDs, Sandbox privileges, positions, and prompts are never configuration inputs.

The game service's `createAi`, `details`, and `unfinishedGame` methods create and restore these games through identity locks, scoped unfinished-owner constraints, and full-history verification. Details combine an unchanged chess snapshot with its private configuration in one read transaction. Every unfinished-game lookup requires an explicit ordinary or Sandbox scope: ordinary creation/discovery excludes Sandbox, and Sandbox creation/discovery excludes ordinary games. Creation conflicts return only the occupied game's snapshot from that scope. Ordinary AI reads are owner-only, and ownership grants no human move or resignation authority over an AI seat. Configuration restoration rejects inconsistent mode, seat, or owner assignment before any command is accepted.

`games.mode` stores the ordinary AI mode. Legacy records retain null mode and their original `is_sandbox` value; null mode grants no additional authority. AI provider and model ID are typed participant columns, with bounded, closed parameter metadata in `jsonb`. Human seats have null AI fields. Parameter schemas supply structural bounds; provider capability validation and filtering belong at the discovery/inference boundary. See the [migration instructions](development.md#migrations) and [roadmap](roadmap.md#phase-2--ai-arena-core).

### Private account history

`GET /games/history` requires a valid account session and lists only that account's terminal public AI games. The repository reads bounded summaries and their participants in a read-only `REPEATABLE READ` transaction; it does not load moves or PGN for a list. Pagination orders by terminal `updated_at` and game UUID descending. Cursors preserve PostgreSQL microseconds, so ties and sub-millisecond finishes cannot lose rows. Newer finishes appear on a fresh first-page read; they do not shift later pages. Human labels use the current chosen username, consistent with the policy that usernames are not historical aliases. Older accounts with no chosen username retain history access and receive a localized owning-player fallback.

The `/history` screen binds requests and private rows to the account lifetime and clears them on identity loss/change. It links to the existing private `/?game=<uuid>` details, replay, invocation, and canonical PGN paths. History reads never recover unfinished games or acquire a controller. Unfinished discovery remains separate. See the [history API](development.md#private-history-api) for bounds and wire behavior.

### AI failure policy and invocation records

AI execution uses the reservations in [ADR-0009](decisions/0009-ai-turn-reservations.md) and the durable failure policy in [ADR-0010](decisions/0010-ai-failure-policy-and-invocations.md). `ai_turns` identifies a logical turn by game and next ply, independent of lifecycle revisions. Its invalid-output budget survives Pause/Resume and explicit crash recovery. Each dispatch gets a numbered `model_invocations` row before calling the injected adapter outside the transaction.

The executor rechecks authority, seat configuration, revision, and reservation at each dispatch/outcome. Known invalid outputs increment the durable count; the third commits the trusted domain technical loss and an internal `technical_loss` command receipt. Provider failures commit an ordinary pause under the AI command ID and return the paused snapshot. They never consume invalid-output budget. Both outcomes, and successful moves, commit their required attempt, counter, and command records atomically. Explicit Resume or Next move and a fresh versioned command authorize another attempt on the same logical turn.

`GameService.invocations` exposes private normalized records in a read-only transaction after the same ownership and full-history checks as game reads. Records include the exact parameters supplied to the adapter, service-measured duration, independently nullable reported usage, safe enumerated failure causes, and accepted commentary. A logical turn links all its attempts to the accepted move; failures without a move remain readable. Invocation reads are separate from chess snapshots, and operational metadata may change without a game revision. Commentary never enters PGN or model context. Raw responses, prompts, exceptions, credentials, and upstream request IDs are not persisted.

Lifecycle commands interrupt unfinished attempt records while invalidating reservations. A late result may update only its own attempt as discarded, never a counter or canonical game outcome. Unresolved dispatches retain unknown duration/usage; recovery neither invents an upstream result nor silently retries it. The public controller reads these records independently of chess revisions for commentary, telemetry, Events, and safe provider-error guidance. Reads refresh during unfinished games and on explicit Refresh details, including terminal games; request lifetime, game ID, and revision fence stale responses. These reads cannot dispatch moves.

Live commentary shows each AI seat's latest accepted move. Replay selects only the chosen ply's accepted commentary, measured latency, and independently reported token counts. Human moves and the initial position have distinct empty states. Operational totals include every recorded attempt, including failures and discarded calls; a missing measurement or missing historical AI-move record makes the affected total unavailable. Events show attempt sequence, invalid-output budget, safe reasons, and the terminal result. Commentary remains plain untrusted text and never enters canonical PGN.

### Sandbox web client

The application shell separates the public AI Arena (`/`) from Sandbox (`/sandbox`). Vite exposes only the explicit `SANDBOX_ENABLED` value from the shared root environment to the web environment validator; it does not expose other server variables. The flag controls navigation, screen mounting, and a build-time import boundary: disabled builds omit the Sandbox client; enabled builds load it lazily on the Sandbox route, keeping navigation and a localized loading notice visible while it downloads. API authorization remains authoritative. Native page links leave the sandbox controller's lifetime; returning uses the existing paused-recovery flow. Each mode controller resolves game parameters on its own route through authorized reads.

`apps/web/src/api/client.ts` validates HTTP requests and responses with the existing contracts, uses credentialed/no-store requests, and cancels requests after ten seconds or when their owner disconnects. It retains only safe error codes and validated conflict snapshots; server message fields and exception text never enter the UI. The FEN presentation parser checks display syntax without generating moves or adjudicating games.

The sandbox controller owns networking and complete accepted snapshots. `game/SandboxScreen.tsx` connects it through `useSandbox`, while `game/presentation.ts` and `game/statusPresentation.ts` project accepted state into board, participant, and status data. The adapters in `game/panels` translate commands into presentation callbacks. `app/AppShell.tsx` owns shared page landmarks; `arena` owns layout and reusable panels. Architecture checks prevent arena, board, and UI production components from importing sandbox state/controllers or the HTTP client. A different mode supplies its own adapter and authorized actions; a presentation callback never grants server authority.

`arena/ArenaDetails.tsx` accepts Moves plus optional commentary, telemetry, Analysis, and Events content. It renders only supplied extensions; Sandbox supplies Moves and its own guidance/recovery actions. Additional detail panels use keyboard-operated tabs that preserve local state. The development-only `/dev/arena` reference adapter exercises the same shell, layout, board, participants, lifecycle controls, and replay with fictional human/AI scenarios. It uses legal fixture history from the chess package without importing Sandbox or HTTP modules. Its lazy entry is excluded from production builds and also requires the Sandbox flag; these fixtures do not implement or authorize any public game mode.

React subscribes through `useSyncExternalStore`; square selection, focus, orientation, and promotion remain separate component state. Presentation projections do not cache private snapshots or merge partial revisions. Only `legalMoves` supplies selectable sources, destinations, and promotion suffixes. A synchronous guard serializes creation, moves, and lifecycle commands before React can render pending feedback. Commands use the actual snapshot revision and a fresh UUID, and responses must belong to the current game/request generation without regressing the accepted revision.

Client flow, replay, and export state use discriminated unions. The store accepts complete typed substates instead of partial field patches, publishing phase, snapshot, and pending-command changes atomically. Changing the accepted game or revision, or clearing access, clears its private replay and export state in the same notification.

- Mounting checks readiness and reads the URL's game or discovers the existing guest's unfinished sandbox. Anonymous discovery returns to entry; only explicit Start bootstraps a guest before creation. Readiness does not imply sandbox availability.
- Creation conflicts recover the authorized game paused. Command conflicts replace the complete snapshot and invalidate stale selection/promotion without automatically repeating a user command.
- Rejected moves synchronize with an authorized GET before permitting another move. A failed synchronization keeps the board inspectable and movement blocked.
- Network, timeout, server, or malformed-response failures retain the original command and fetch the authorized snapshot. An unchanged revision cannot prove that the original request will not commit; new moves remain blocked. Explicit retry reuses the identical UUID, revision, and UCI. A newer revision makes that old command unable to commit, so the returned position can be adopted safely.
- Access failures on loaded games clear the snapshot and require explicit action before another guest bootstrap. No game state is persisted in browser storage.

The web localization layer uses bundled, typed i18next/react-i18next English resources with English fallback. Metadata, configuration errors, the failure screen that an error boundary shows when rendering throws, controls, board descriptions, and one polite atomic live region use the catalog; a caught exception is reported to React but never rendered. There is no language selector or browser-language detection. The [design guide](design-system.md#keyboard-and-chess-interaction) defines grid/dialog semantics and focus behavior; the [browser tests](development.md#browser-tests) exercise the real guest-command flow.

Recovery sends the same versioned pause command as the Pause control. It reconciles active conflict snapshots with at most three automatic attempts, then requires Retry recovery. An uncertain pause keeps its original command for explicit retry. No recovered active snapshot enables play; an already-paused game needs no write, and Resume is always explicit. Snapshot/discovery GETs never change game lifecycle. URL navigation cancels obsolete requests, clears private view state, and resolves the target through guest authorization.

Terminal replay and PGN use the same authorized full-history verification as snapshots. Replay returns the terminal snapshot and initial FEN; a separate client cursor selects the displayed verified FEN/SAN/UCI without modifying the accepted snapshot. Export returns the verified canonical PGN in JSON. Copy and UTF-8 file download use identical text, with a selectable-text clipboard fallback. These endpoints reject unfinished games; access loss clears loaded private data. There are no provider adapters, rooms, or WebSockets in this flow.

### AI turns

The browser requests one AI turn at a time. The API:

1. authorizes the requester and reserves the expected turn/version;
2. builds the canonical model context from server state;
3. resolves a session-only key from the request or decrypts an explicitly saved credential;
4. calls the selected provider adapter outside a long-running database transaction;
5. validates and normalizes the response;
6. retries model-invalid output at most twice;
7. commits the legal move only if the game version is still current;
8. returns the new state and normalized telemetry.

The reservation must be idempotent so multiple clicks, retries, or network duplicates cannot cause multiple moves. If the controlling tab disconnects, automatic turn requests stop and the game becomes paused.

The game service's `aiTurn` accepts a game ID, expected revision, command ID, controller UUID, optional paused-step flag, and request-scoped adapter access. It builds the standard response instruction and chess context from verified server history. A separate `ai_turn_reservations` row fences execution; `game_commands` records only accepted moves/lifecycle changes. Discovery and inference hold no database transaction. After reservation, live discovery validates the current model and resolves effective parameters before an invocation is recorded. Authority, seat/configuration, reservation identity, and revision are rechecked before inference and before acceptance, which uses the same deterministic move and atomic persistence path as human commands.

AI HTTP requests cancel provider work when the response connection closes. Discovery has a 30-second operational deadline; a turn, including discovery and automatic invalid-output retries, has a 180-second deadline. A dispatched turn's cancellation or timeout follows the provider-pause policy, never a chess loss. The AI client allows 35/190 seconds respectively so the API can persist and acknowledge an operational failure, propagates its owner's cancellation, and never retries transport failures automatically. An uncertain response still requires authorized synchronization and explicit recovery; a lost response cannot prove that no move committed. These deadlines are transport safeguards, not chess clocks.

Failed or interrupted executions retain a blocked reservation. A process crash can leave an apparently in-flight reservation; it never expires into automatic redispatch. Explicit owner-authorized Pause advances the revision and invalidates the reservation before Resume and another turn can authorize a new call. Accepted ordinary-game commands clear reservations atomically; reads do not. Expired controller presence also authorizes a server pause, never another provider call. See [ADR-0009](decisions/0009-ai-turn-reservations.md) for receipt identity, cancellation, rollback, crash recovery, and the limits of provider billing guarantees. Failure-policy and public-flow implementation status remains in the [roadmap](roadmap.md#phase-2--ai-arena-core).

### AI controller presence and recovery

The public `match` controller holds complete accepted snapshots, page-memory credentials, and one unresolved inference identity at a time. It never advances the board speculatively. Pause, Stop, and human resignation use a separate lifecycle request lane; accepted controls invalidate pending inference. The speed setting delays the next AI request after the previous complete response. A lost acknowledgement blocks dispatch until synchronization and a versioned pause establish a safe revision. AI seats remain read-only to human commands.

As specified in [ADR-0011](decisions/0011-ai-controller-presence-and-step.md), an authenticated owner claims a database controller lease with a page-memory UUID. Three-second heartbeats renew a 15-second lease; expired or replaced controllers cannot dispatch or accept provider outcomes. Every API instance sweeps expired presence at startup and every two seconds, committing an authoritative pause under the existing lock/receipt machinery. Initial unclaimed games also expire. During total API/database downtime the pause is deferred until service returns, while the persisted expiry still fences acceptance.

Opening an unfinished game at `/?game=<uuid>` performs authorized reads followed by an explicit versioned pause without a controller UUID. This revokes any competing tab and outstanding execution, including a paused step. No GET changes lifecycle. The recovered tab needs missing keys and explicit Resume or Next move before claiming control. Navigation, close, refresh, and bfcache entry stop automatic requests and clear keys; unload delivery is not needed for server enforcement. Provider errors show only localized safe causes and require user-directed continuation.

`step: true` authorizes one AI move while the stored game is paused. The executor resumes only its reconstructed in-memory aggregate to build legal context and apply the deterministic move. It persists the move and final paused or terminal position at one revision, without an intermediate active record or playable paused snapshot. Its reservations, failure budgets, and technical-loss policy are identical to ordinary AI turns.

### Human turns

AI-versus-human setup assigns the guest only to the selected human color and requires a credential only for the opponent. Switching a seat to human cancels its discovery and clears its key and AI selections. The public match controller uses the shared HTTP move command, board, promotion, and private replay path. It waits on human turns and dispatches one AI turn after an accepted human move; AI White opens when the human chooses Black. The initial board orientation follows the human color. A paused step is available only on an AI turn.

Unacknowledged human moves follow the [Sandbox web client's uncertain-command policy](#sandbox-web-client). Recovery fences unresolved work with a versioned pause before explicit continuation. Only the human seat has a confirmed resignation action, including paused and off-turn positions; a conflicting revision requires a new decision instead of automatically resubmitting resignation. No room transport is used for this mode.

Human moves use the same authoritative command path without a provider call. For online games, the accepted state is broadcast to both room participants over WebSocket. Reconnecting clients fetch a full snapshot before processing later events.

### Local development sandbox

Phase 1 provides an explicitly labeled development screen where one guest session controls White and Black in turn. It uses the real API, PostgreSQL persistence, chess rules, and reusable UI components through the shared command service.

- Enable the sandbox explicitly on the server in local development or tests; keep it disabled by default. Production configuration must reject attempts to enable it. Hiding a frontend route is insufficient.
- Mark sandbox games internally when the server creates them. Only their owning guest session receives authority over both seats. Clients cannot grant themselves this capability or apply it to ordinary games, and production game access must not recognize sandbox authority.
- Preserve every lifecycle, turn, legality, version, and atomic persistence check. Both-seat control never permits moving out of turn or changing an accepted position.
- Keep sandbox records in the development/test database. The sandbox creates no room, invitation, join flow, public spectator access, or additional public game mode.
- Start each sandbox game from the standard position. Special FEN positions are allowed only as internal test fixtures, never through a game-creation API.

Apply the [guest identity and ownership rules](#authentication-and-guest-sessions). Unfinished sandbox games recover as paused on refresh/reopening and require explicit resume. Completed or aborted records remain available for private replay and PGN export at their game URL during the retained guest session, including after a new game starts. They do not become account history. The production guest retention period and automated cleanup remain follow-up decisions.

## AI provider boundary

Each provider adapter implements equivalent operations conceptually:

```ts
interface AiProviderAdapter {
  readonly provider: AiProvider;
  listModels(input: ListModelsInput): Promise<ModelDiscoveryResult>;
  requestMove(input: MoveRequest): Promise<NormalizedMoveResponse>;
}
```

`ModelDescriptor` includes capability metadata used to build a capability-aware configuration UI. The server filters unsupported parameters rather than sending speculative fields to a provider.

Shared schemas distinguish supported, unsupported, and unknown move-generation capability; null parameter capability never enables a speculative control. Normalized operations return discriminated success/failure results with enumerated diagnostics, excluding upstream exception text. Usage may be entirely null or contain independently nullable reported counts; absent totals are never synthesized. Adapter inputs carry cancellation and a request-scoped key, which must not be retained on the adapter. The reusable scripted adapter lives only in API test fixtures, with an architecture guard excluding it from production imports.

The normalized move response contains:

- required UCI move;
- optional viewer commentary;
- provider request identifier when safe to retain;
- latency;
- normalized token usage when available;
- retry and error classification.

Model lists come from the selected provider through the API. Discovery is currently uncached and scoped to the supplied request credential; another account's catalog is never reused. Malformed, mismatched-provider, or credential-echoing descriptors become safe provider failures. A missing or explicitly unsupported selected model pauses a turn without inference. Unknown move-generation capability permits a runtime attempt with no optional parameters. For supported models, unknown/unsupported parameter fields are omitted; values outside an advertised range or enumeration pause the game and return `AI_PARAMETERS_INVALID` before inference, without consuming an invalid-output attempt. Seat configuration is immutable, so a changed range that invalidates a selection requires a new configuration/game. Invocation records contain the parameters actually supplied to inference. Discovery failures retain a safe failure attempt with no effective parameters or token usage.

A model being listed does not guarantee it supports the required chess response contract; adapters must surface capability or runtime errors clearly. Registration is explicit through `aiAdapters`; production has no fixture adapter or fallback.

The [OpenAI adapter](development.md#openai-adapter) uses stateless Responses API requests and annotates live model discovery with conservative documented capabilities. The [Anthropic adapter](development.md#anthropic-adapter) uses Messages and paginated discovery with advertised output/effort capabilities. The [Google adapter](development.md#google-adapter) uses GenerateContent and paginated discovery with advertised generation methods, temperature ranges, and output limits. The [OpenRouter adapter](development.md#openrouter-adapter) uses Chat Completions and account-filtered discovery, preserving routed identifiers and advertised capabilities while disabling fallback requests and context compression. An optional pure adapter parameter resolver supplies required wire defaults before invocation persistence; discovered capabilities are passed within the request, never retained on the adapter. These adapters discard raw usage metadata after extracting reported counts and perform no implicit transport retries. The common executor retains all legality, retry-budget, lifecycle, and persistence authority.

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

## Authentication and guest sessions

Better Auth is the authentication authority for email/password, Google, GitHub, verification, reset, and PostgreSQL sessions. The API configures it through the server-only database package's Drizzle adapter; generated `user`, `account`, `session`, and `verification` tables share the existing migration history. See the [roadmap](roadmap.md#phase-3--accounts-encrypted-credentials-and-history) for lifecycle delivery status. Profiles add a unique username and avatar metadata.

The Fastify auth boundary uses an explicit endpoint allowlist; library endpoints become available only when their complete product flows ship. Responses use validated application contracts and localized errors, with bearer tokens excluded from application JSON. See the [account session foundation](development.md#account-session-foundation) for enabled endpoints, response projections, cookie settings, session lifetimes, and rate limits.

SameSite=Lax permits OAuth top-level GET callbacks while exact-origin JSON commands and Better Auth's CSRF checks remain enabled. Only the two provider callback routes admit cross-origin navigation, with Better Auth validating its signed state cookie, stored state, expiry, and PKCE. Server-controlled state binds the initiating provider and, for linking, the session ID. Caller-controlled forwarding headers must not determine the public auth origin or client IP because clients could spoof the origin or bypass rate limits. Base URLs and trusted origins come from validated configuration, and rate limiting uses Fastify's socket-derived IP. The process-memory limiter assumes a single API instance; proxy trust and shared limiting require deliberate deployment configuration before scaling.

Google/GitHub use Better Auth's provider authorization and callback orchestration with injected, bounded API transports. The transports reject redirects, enforce timeouts, validate token/profile responses, and suppress upstream diagnostics (the built-in GitHub transport in 1.7.5 can write error bodies through a global logger). Google identity comes from its authenticated UserInfo endpoint using the server-exchanged access token, not a client-submitted or merely decoded ID token. GitHub uses its stable numeric ID and verified primary email. No raw profile or provider name is persisted; only the provider subject, verified email, and an approved initial avatar URL are admitted. Returning sign-in and linking preserve the local profile. PostgreSQL uniquely constrains `(provider_id, account_id)` across account owners.

Implicit linking stays disabled. Explicit linking requires the same verified email and the same fresh PostgreSQL session at initiation and callback. Access tokens exist only during the callback; refresh/ID tokens are discarded, and database hooks clear token, expiry, and scope fields on account writes. Account cookies and token read/refresh endpoints stay disabled. `encryptOAuthTokens` remains enabled as defense in depth for library writes before the discard hook; retaining tokens would require a deliberate policy change. Callback redirects use a fixed completion path with only an enumerated result in the fragment, dropping raw codes, state, provider errors, and descriptions. See [OAuth setup and callbacks](development.md#google-and-github-oauth).

The API's server-only `identity` boundary supplies a discriminated principal independently of game permissions. Guest authentication resolves the cookie to the stored guest ID; `guests/http.ts` owns cookie renewal. Game services use centralized identity validity/locking checks before applying ownership, human-seat, and controller permissions. A principal is not proof of continued validity. Reads check expiry, commands lock the identity before the game, and AI dispatch/outcome paths recheck through command preparation. Trusted maintenance has a separate lock path that preserves ordering even after access expires; it cannot authorize a provider dispatch. See [ADR-0013](decisions/0013-principal-and-account-ownership.md).

The account resolver returns a Better Auth-validated user/session principal without a token. Public game and model-discovery routes prefer a valid account over any guest cookie. Missing account credentials return no account identity; present but invalid or expired credentials fail authentication and never trigger guest fallback. Account clients also send `X-Neurochess-Identity: account`, so a removed/expired cookie still fails closed. This validated context is not an identity or permission grant; `guest` never overrides a valid account. Session lookup always consults PostgreSQL and does not renew cookies internally. Never accept client account/guest IDs as authentication. Sandbox routes, including shared `/games/:gameId` routes for server-marked Sandbox records, select only the guest identity and retain the development gate.

Account commands lock the user row, then the calling session row, then the game. The user lock serializes creation across devices; the session share lock fences concurrent revocation during the short command transaction. Validity uses the database clock after identity/session lock waits and again after game lock waits. AI reservation, discovery dispatch, inference dispatch/retry, and outcomes use the same checks, without holding database locks during provider calls. Standalone discovery rechecks identity before returning its catalog. Maintenance locks only the owning guest/user before the game, tolerates missing/expired sessions, and cannot dispatch providers. Presence leases still require the selected owner's authority; recovery clears the previous controller and fences late outcomes.

Guest games never migrate at sign-in. Account requests cannot combine permissions from both cookies. Identity changes cancel the old page's controller activity and clear secrets/private state; account recovery retains the existing explicit paused-recovery protocol. The owner-based unfinished index must be extended for non-owning room participants in Phase 4 before joining is enabled.

Profiles follow the [username and avatar contract](product.md#usernames-and-avatars). A private `profiles` row, keyed by the stable auth user ID, stores the chosen display/normalized username and avatar preference. PostgreSQL checks the ASCII shape, reserved names, and exact normalization, and uniquely indexes the normalized name. The row is created on the first profile update; absent rows and null usernames require onboarding. New account-game creation checks completion under the user lock, independently of authentication method. Existing games retain their stable ownership, seat assignments, and recovery authority.

Profile reads and writes use user-before-session locks and recheck session expiry after lock waits; writes also recheck after a potentially blocked username claim. Username and avatar changes commit together. The initial provider URL remains in Better Auth's `user.image`; the profile response revalidates it against the approved hosts and a matching linked provider. Only the stored candidate can be explicitly reselected; an initials preference persists across sign-in. Invalid/missing candidates fall back to initials derived solely from the chosen username (null before onboarding). The API never fetches images; the browser must use the supplied initials if an image fails to load. Profile responses omit email, auth names, tokens, and user IDs and have no directory or arbitrary-account route. See the [profile API](development.md#private-profile-api).

Authentication integrates an injected email sender with a configurable working transport (SMTP is the initial transport) and an isolated test mailbox. Verification/reset links are never logged, CI never requires outbound email, and production must reject test-only delivery configuration. OAuth account linking is explicitly configured rather than inherited from framework defaults.

The Fastify boundary completes registration before requesting verification delivery through Better Auth, keeping SMTP outside the registration transaction. It awaits email submission and tracks delivery failures per request because Better Auth 1.7.5 suppresses errors from its reset-email callback. Failed sends cannot produce a success acknowledgement; signup may already have committed an unverified account, which can retry. The SMTP adapter suppresses transport diagnostics and requires verified TLS outside a loopback development/test mailbox. Only the test harness supplies an in-memory sender.

Email links use fixed paths at the configured web origin and carry tokens in fragments. The client must consume the fragment into page memory and remove it from browser history before rendering or sending requests. Completion uses exact-origin JSON POSTs; the boundary translates verification to Better Auth's internal GET. Public library email callback redirects and caller-supplied callback destinations remain closed. See the [email lifecycle API and setup](development.md#email-lifecycle-api-and-delivery) and the [product policy](product.md#email-account-lifecycle).

The browser's account boundary validates the session before mounting public game setup/recovery. Each identity lifetime owns an abort signal and a fresh game controller; replacement clears private state, keys, scheduled turns, and heartbeats. A non-secret context marker prevents reload from silently falling back to guest play after account loss. Storage notifications, focus/visibility checks, visible-page polling, known expiry, and unauthorized API responses revalidate the session. Notifications contain no identities or credentials. A new login always enters ordinary paused recovery. See [browser account flows](development.md#browser-account-flows) for routes, navigation, and detection limits.

Guests explicitly bootstrap an opaque 256-bit token in a host-only Secure, HttpOnly, SameSite=Strict cookie before creating a game. Only its SHA-256 digest is stored with an internal guest UUID. Bootstrap reuses valid identities; other endpoints reject missing or expired identities rather than creating replacements. Valid activity renews the configured inactivity expiry without rotating the token (24 hours by default). Exact-Origin POST enforcement and credentialed CORS complement the cookie policy. See [ADR-0006](decisions/0006-guest-owned-game-commands.md).

Temporary game metadata does not appear in durable history. Access expires now; automated deletion after inactivity and the production retention duration are follow-up work and must be resolved before production guest gameplay.

Guest identity, ownership checks on snapshots/commands/replay/PGN, and the active-or-paused game limit are required from Phase 1. A game ID alone never grants access. Phase 3 extends these foundations to authenticated users and durable private history.

After refresh, an AI game is restored as paused and requires explicit resume. Session-only key loss and mandatory re-entry are required when AI games arrive in Phase 2; an authenticated user's explicitly saved credential may be resolved through the saved-credential path introduced in Phase 3.

## Credential lifecycle

### Session-only credential

1. The browser accepts the key into in-memory state.
2. It sends the key over HTTPS only to provider-related API operations that require it.
3. The API uses it within that request and does not persist or log it.
4. Refreshing or closing the tab removes it; a restored game remains paused until re-entry.

The AI client's credential store is a page-owned closure with independent color/provider entries, each holding an exclusive raw key or explicitly selected saved reference. Replacement, explicit clearing, owner cancellation, and `pagehide` remove entries; even a page restored from the browser's back/forward cache requires re-entry or selection. It exposes no serializable credential state and uses no browser persistence. Configuration and command receipts never contain credentials; the HTTP turn body adds its credential source only for that operation. Client destinations require HTTPS except for local development on `localhost`. Loading or constructing the client never bootstraps a guest.

The independent setup adapter in `apps/web/src/setup` consumes that client and a page-owned credential store. It reads unfinished-game discovery on mount; only explicit Load models or Start actions may bootstrap a guest. Each seat cancels and discards obsolete discovery on key/provider/source changes, clears model/parameter selections before refreshing capabilities, and submits only supported, valid parameters. Reusable `arena/setup` controls receive data and callbacks, without importing API clients or mode controllers. Creation hands private game details to the page owner, which retains the credential lifetime; Return to game hands over only the authorized game ID. Setup itself neither dispatches turns nor performs recovery; its page owner handles those operations. An uncertain creation response requires explicit unfinished-game discovery before another creation attempt. The page-owned `match` controller connects this handoff to the public Arena and owns recovery, controller heartbeats, and serialized turns.

### Saved credential

1. Only an authenticated user may opt in to saving a key.
2. The API encrypts the key with authenticated encryption before database insertion.
3. The database stores ciphertext and required cryptographic metadata, never the plaintext key.
4. The encryption key lives in deployment secret storage, separately from PostgreSQL.
5. Reads return masked metadata only. Decryption occurs only for an authorized provider call.
6. Users can revoke individual saved keys, clear credentials, or delete the account.

The storage API uses versioned AES-256-GCM envelopes with authenticated owner,
provider, and record context; [ADR-0014](decisions/0014-provider-credential-encryption.md)
specifies the format and keyring boundary. The database repository accepts encrypted
material only. Metadata reads never select ciphertext and never decrypt, including
when an encryption key is unavailable. Save/revoke/clear take the user update lock,
then the session share lock; reads use user/session share locks. Every operation
rechecks session validity after SQL waits, rolling back expired writes. Clear removes
all credentials visible under that account lock; a later serialized save survives.
All HTTP commands require exact-origin JSON and reject caller-supplied ownership.
See [credential setup and operations](development.md#saved-provider-credentials).

The account UI keeps paginated masked metadata in the current identity's memory,
separate from the page-owned seat credential store. Identity changes cancel reads
and mutations and fence late replies. Saving requires an unchecked-by-default
opt-in and explicit submission; the submitted raw field is cleared immediately.
An uncertain save requires refreshing metadata before another explicit save.
Revoke and clear have separate confirmations that explain future-operation and
in-flight effects. Neither management nor selection requests plaintext readback.

Saved credentials are explicitly selected per AI seat, including after recovery; no provider-based automatic selection or persisted per-game credential preference is required. Revocation prevents subsequent authorized operations and is rechecked before each automatic retry. Already-dispatched provider work cannot be undone; its result may complete only while the principal, game, reservation, and controller remain authorized. Account deletion fences acceptance and cleanup so late work cannot recreate data. Neither saved keys nor account sessions permit background AI play.

Provider operations accept an exclusive session-only key or saved reference. The
API resolves the reference through an owner/provider-scoped encrypted lookup in
the existing short account-before-game transaction, after operation authorization.
Decryption and session revalidation occur within that scope; database locks end
before the external call. Resolve independently before discovery, inference, and
each automatic retry, and release plaintext after each operation. Missing,
foreign, mismatched, revoked, or undecryptable credentials normalize to
`provider_auth`; turn execution records a recoverable provider error with unknown
usage and pauses without consuming the invalid-output budget. Neither source nor
plaintext belongs in durable game configuration, receipts, or telemetry.

All request logging and exception reporting must redact credential fields, authorization headers, cookies, URLs with tokens, and provider secrets.

## Realtime rooms

The Fastify process owns active WebSocket connections. PostgreSQL stores canonical room and game state, allowing a client to reconnect after a connection loss or process restart.

MVP assumptions:

- one API instance is sufficient;
- no Redis dependency;
- invitation codes are random, unguessable, stored safely, and revocable;
- only an authenticated room owner can abort the room;
- an aborted game is retained for registered participants;
- games and rooms are private.

If the API is scaled horizontally, add a shared pub/sub or connection-routing layer through a new ADR.

## Telemetry and cost

Store operational metadata required by the product: provider/model, attempt number, duration, reported tokens, normalized errors, and estimated cost. Never store raw keys. Avoid storing complete raw provider payloads by default; retain the normalized move and user-facing commentary needed for replay.

Cost calculation uses provider-reported token counts and versioned pricing metadata when available. Every cost is labeled as an estimate. Unknown usage or price produces `unavailable`, not zero.

## API shape

The exact paths remain an implementation detail, but the API needs these capability groups:

- auth and profile management;
- provider model discovery and credential management;
- game creation, snapshot, command, pause/resume, abort, replay, deletion, and PGN;
- room creation, invitation resolution, join, reconnect, and abort;
- WebSocket snapshot/event protocol;
- history listing and account/data deletion.

Generate OpenAPI from Fastify route schemas. Version WebSocket event payloads through shared runtime schemas.

## Verification strategy

- Unit tests: chess state transitions, legal move validation, result rules, provider normalization, retry classification, cost calculation, and redaction.
- Integration tests: Fastify routes, Better Auth authorization, Drizzle repositories, migrations, credential encryption, deletion cascades, and idempotent AI turns.
- WebSocket tests: invitation join, move broadcast, disconnect/reconnect snapshot, owner abort, and unauthorized access.
- Provider contract tests: recorded or mocked responses for every adapter; no live paid calls in the default suite.
- End-to-end tests: the three game modes, guest restrictions, history/replay/PGN, responsive layouts, and key lifecycle.

Phase 1 acceptance must additionally verify:

- one guest completes a game through human commands, replays it, and exports PGN without loading a provider adapter; another guest cannot read or mutate any of these resources;
- sandbox creation/control paths are unavailable when disabled, production cannot enable them, and ordinary games never inherit authority over both seats;
- concurrent game creation respects the active/paused limit, completion or abortion releases the slot, and duplicate move submissions append only one move;
- refresh recovers an unfinished game paused, and resume preserves the full move history;
- repeating `g1f3 g8f6 f3g1 f6g8` twice from the initial position ends the game on the eighth half-move, including after database restoration between the cycles;
- internal fixtures verify the 99-to-100 half-move boundary, pawn/capture counter resets, repetition identity, and checkmate priority without exposing arbitrary-FEN creation;
- completed and aborted games reject new moves, and replay/PGN agree with the persisted result and termination reason.

## Deployment constraints

The web app can be hosted as static assets. The API hosting environment must support a long-running Node.js Fastify process and persistent WebSocket connections. PostgreSQL should be managed or backed up appropriately and reached over TLS. Both applications should be containerizable.

The exact providers, production region, production email delivery vendor, observability service, and backup policy remain open decisions. Custom avatar uploads are outside the MVP.
