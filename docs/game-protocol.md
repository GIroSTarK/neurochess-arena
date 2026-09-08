# Game protocol

Reference for the current guest command API, persistence, browser synchronization, and recovery in AI modes and the development sandbox. [Product](product.md) owns game behavior, [architecture](architecture.md) owns component boundaries, and [gameplay](gameplay.md) describes the controls. Account and room extensions must resolve the relevant [open product decisions](product.md#open-product-decisions).

## Terms and counters

| Term                  | Meaning                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ply                   | One accepted chess move by one side. Lifecycle commands are not plies.                                                                                                |
| Game version          | Aggregate revision. Each accepted persisted command advances it once; a new game starts at version zero.                                                              |
| Command ID            | Game-scoped UUID for one intended command. Human/lifecycle retries reuse the identical command; a manually retried AI turn uses a fresh ID.                           |
| Execution ID          | Server-generated UUID identifying the request that owns an AI reservation; never an authentication credential.                                                        |
| Reservation attempt   | Sequential provider call within one reservation, limited to an initial attempt and two model-invalid retries.                                                         |
| Displayed attempt     | Chronological call number for a ply across reservations, including provider failures and interruptions. It can exceed three.                                          |
| Invalid-output budget | Recorded `model_invalid` responses for the current seat and chess turn across reservations. The third causes technical loss; only an accepted move resets the budget. |

Provider errors and unresolved/abandoned calls do not consume the invalid-output budget. A recorded invalid response still counts when a later lifecycle change cancels its reservation. See [ADR-0010](decisions/0010-ai-paused-stepping-and-retry-accounting.md).

## Guest identity and authorization

Bootstrap with `POST /guest-session` and await the cookie before issuing protected requests. Clients serialize first-use bootstrap to avoid creating competing cookie-less identities. Sandbox entry bootstraps only on explicit Start; opening AI setup establishes its guest session before checking providers and the unfinished slot.

The server creates a random 256-bit token in a host-only `__Host-neurochess_guest` cookie with Secure, HttpOnly, SameSite=Strict, Path=/, and renewed Max-Age. Only its SHA-256 digest and an internal guest UUID enter PostgreSQL. Valid activity renews the configured inactivity expiry without rotating the token; the default is 24 hours. Other endpoints reject missing/expired identities instead of minting replacements. Bootstrap can replace an expired session but cannot recover its old games. See [ADR-0006](decisions/0006-guest-owned-game-commands.md).

Browser requests use `credentials: "include"`; all POSTs require JSON and an Origin exactly equal to `WEB_ORIGIN`, including command-line clients. Use `localhost` consistently for HTTP development, where supported browsers allow Secure cookies. Other hosts require HTTPS; there is no insecure-cookie override. A cookie jar is a bearer credential: never print, commit, or share its contents.

All game reads and commands establish authorization before disclosing state. A game ID is only a resource pointer. Ownership grants lifecycle controls, not ordinary human-seat authority: the requester must occupy the chosen/current human seat. Only an enabled, non-production, server-marked sandbox grants its owner both-seat control. AI ownership never permits moving or resigning an AI seat.

## Sandbox and shared game API

Enable `SANDBOX_ENABLED=true` in non-production only. Disabled servers also reject access to existing sandbox records; production rejects enablement. Shared game routes serve authorized AI games without sandbox enablement.

| Endpoint                        | Request                                                        | Success                                            |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| `POST /guest-session`           | `{}`                                                           | `200 { "status": "ready" }` plus guest cookie      |
| `POST /sandbox/games`           | `{}`                                                           | `201` standard-position active snapshot, version 0 |
| `GET /sandbox/games/unfinished` | No query fields                                                | `200 { snapshot }`, unfinished sandbox or `null`   |
| `GET /games/:gameId`            | UUID parameter, no query fields                                | `200` current authorized snapshot                  |
| `POST /games/:gameId/moves`     | `{ gameId, move, expectedVersion, commandId }`                 | `200` accepted snapshot                            |
| `POST /games/:gameId/lifecycle` | `{ gameId, action, expectedVersion, commandId, losingColor? }` | `200` accepted snapshot                            |
| `GET /games/:gameId/replay`     | UUID parameter, no query fields                                | `200 { snapshot, initialFen }`, terminal only      |
| `GET /games/:gameId/pgn`        | UUID parameter, no query fields                                | `200 { gameId, version, pgn }`, terminal only      |

Lifecycle actions are `pause`, `resume`, `abort`, and `resign`. Only resignation accepts and requires `losingColor` (`white` or `black`). Moves use canonical UCI. Bodies must match the path game ID; unknown body/query fields are rejected. Clients cannot select FEN, history, owner identities, or sandbox authority.

PowerShell example after [local setup](development.md#local-setup), using a temporary cookie jar for this CLI identity:

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

## AI game API

These routes use the same guest, Origin, privacy, and command rules. [Provider discovery](providers.md#provider-discovery-and-session-credentials) supplies the catalog references required by independent setup drafts.

| Endpoint                      | Request                                                                    | Success                                                                           |
| ----------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /ai/games`              | Mode-specific configuration below                                          | `201` standard-position active snapshot, version 0                                |
| `GET /ai/games/unfinished`    | No query fields                                                            | `200 { snapshot }`, owned unfinished AI game or `null`                            |
| `GET /ai/games/:gameId`       | UUID parameter, no query fields                                            | `200 { snapshot, configuration }`, owner-only history and effective configuration |
| `POST /games/:gameId/ai-turn` | `{ gameId, expectedVersion, commandId, credential: { provider, apiKey } }` | `200` snapshot after one active turn or paused step                               |

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

Replace the illustrative model and catalog IDs with actual discovery values. `fixture-model` exists only in tests. Creation resolves each AI selection against trusted server metadata and persists effective configuration; it rejects credentials and client capability claims. The private AI-game read returns this mode-specific configuration without catalog references, along with accepted history and normalized invocation telemetry. It excludes keys, internal identities, reservations, and raw provider data.

The normal `createGameService` composition registers live adapters with request-scoped credentials. Tests inject scripted adapters or mocked provider HTTP; trusted fixture models are server-test inputs only. Creation or a fresh AI turn needing an unregistered adapter returns `404 NOT_FOUND`. Clients cannot submit prompts, execution IDs, lease settings, or authority claims.

AI-versus-human assigns only the selected human color to the guest. Both AI modes and the sandbox share one active/paused slot. AI discovery excludes sandbox/human-room games, never changes lifecycle, and never calls an adapter.

## Command semantics

[Shared runtime schemas](../packages/contracts/src/index.ts) validate all requests, responses, and conflict snapshots. Transport validation does not establish move legality. After read authorization, check accepted/reserved command IDs and expected version before fresh-command lifecycle and current-seat rules. This lets a retry discover the current state even after its original action changed the turn or completed the game.

| Condition                                                                             | Response                                                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Stale/future version, accepted ID reuse, or occupied unfinished-game slot             | `409 GAME_CONFLICT` with authorized `currentSnapshot`                         |
| Duplicate AI reservation, competing execution, expired ownership, or overtaken result | The same authorized conflict envelope; no execution rights                    |
| Fresh move in a terminal or paused game, or replay/export of an unfinished game       | `409 INVALID_GAME_STATE`; paused AI turns are the explicit stepping exception |
| Illegal human move                                                                    | `422`                                                                         |
| Malformed request                                                                     | `400`                                                                         |
| Missing/expired session                                                               | `401`                                                                         |
| Inaccessible game                                                                     | `404`, without a snapshot                                                     |

Accepted IDs are game-scoped and cannot be reused for a changed payload or another command kind. An AI reservation also consumes its command identity even if it is cancelled or abandoned. A duplicate terminal command still returns a conflict snapshot. Only `GAME_CONFLICT` carries a snapshot; errors otherwise use safe codes, localized API messages, and a request ID.

Clients adopt authorized conflict state without automatically applying the original action at a new version. A same-version read/conflict cannot prove an outstanding request will not commit. The [browser synchronization rules](#browser-command-synchronization) distinguish human/lifecycle retries from fresh user-directed AI attempts.

## Persistence

The game service composes independent chess and transport packages with database-owned repository interfaces. It verifies the full ordered UCI history and persisted projections through the [deterministic restoration contract](architecture.md#deterministic-domain-and-core-contracts).

- Writes use `READ COMMITTED`, locking the guest row before the game row and rechecking guest validity after lock waits. Process-local locks are not a correctness mechanism.
- A partial unique owner index enforces the active/paused slot. Future room joining must extend the invariant to non-owning participants before that flow ships.
- An accepted command atomically writes its normalized `game_commands` receipt, lifecycle/result/FEN/PGN, and optional move, advancing the version once. Receipts are unique by game/command ID and game/version. Completion and abortion release the slot in that transaction.
- Snapshot reads use read-only `REPEATABLE READ`, so history and version share one view. Restoration rejects corrupt history or inconsistent aggregate/per-move projections with a safe error; it never repairs data or changes lifecycle implicitly.
- Provider I/O stays outside write transactions. Reservation and invocation writes alone do not advance the game revision or create accepted receipts.

New games start active at revision zero from the standard position. Sandbox creation assigns human White to the owner and leaves human Black unassigned; the server-owned sandbox marker enables the exception. AI participants have independent effective configurations fixed for that game. Human-room creation and membership are separate flows.

The migration and transaction decisions are [ADR-0006](decisions/0006-guest-owned-game-commands.md), [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md), and [ADR-0009](decisions/0009-ai-turn-persistence.md), with the extensions listed below.

## AI turn execution

One HTTP command executes one AI turn from an active or paused game. The application authorizes the persisted seat and position, checks runtime continuity and the separate current-seat credential, then:

1. Reserves the expected revision using a command UUID, a new server execution UUID, and a renewable lease; records a pending invocation in a short transaction.
2. Builds the common FEN/PGN/color/side/legal-move context from the authoritative aggregate and calls the selected adapter outside the transaction.
3. Validates the normalized outcome and records each invalid response before another attempt. Automatic retries use only the remaining current-turn invalid-output budget.
4. Under the commit lock, restores the aggregate again and rechecks access, revision, execution ownership, lease, lifecycle, side, and legality.
5. Atomically records the outcome, accepted move if any, shared receipt, reservation outcome, and new game revision. A provider failure commits a pause; the third invalid response and technical loss commit together.

Only a newly granted reservation may execute provider work. Duplicate, busy, expired, or overtaken requests cannot inherit the original execution UUID or call again. The repository enforces reservation/receipt identity across command kinds and the three-invalid limit alongside the service.

Lease durations are server-controlled, 1–300,000 milliseconds, measured by PostgreSQL after lock waits. The attached executing request renews only a live lease. Expiry never transfers ownership, repeats a potentially billable call, or mutates a GET. HTTP disconnection stops renewal and signals cancellation; an uncertain reservation requires explicit recovery. Unexpected adapter failures return a fixed safe `500` without raw diagnostics.

### Paused stepping and lifecycle races

A paused step resumes only the transaction-local chess aggregate to build context and apply a move; persistent state stays paused during provider I/O. An unfinished result remains paused, while a chess result or technical loss completes the game. Completion writes one receipt and one revision.

Pause, Resume, Stop (`abort`), and authorized human resignation use the shared lifecycle route and never call a provider themselves. A lifecycle write invalidates pending reservations atomically: live reservations become cancelled, expired ones abandoned, and unresolved invocations abandoned with unavailable telemetry. Recorded outcomes remain in history.

Pause advances even an already-paused AI game's revision without a reservation, fencing requests delayed before reservation. Resume also invalidates a pending step. If turn completion wins the lock first, a stale lifecycle command conflicts with its accepted snapshot. A late executor cannot commit against a newer revision.

A manual Retry move uses a fresh AI-turn command at the paused version and leaves an unfinished game paused. Recorded invalid responses survive retry, pause/resume, and interruption. Old command IDs never regain execution rights. See [ADR-0010](decisions/0010-ai-paused-stepping-and-retry-accounting.md) and [ADR-0011](decisions/0011-ai-page-recovery.md).

## Browser command synchronization

The controller owns complete accepted snapshots, operation identity, and networking. React subscribes through `useSyncExternalStore`; square selection, focus, orientation, and promotion remain separate presentation state. Client flow, replay, and export use discriminated unions and atomic store notifications. Changing game/revision or losing access clears its private replay/export state.

A synchronous operation gate serializes submissions before React renders pending feedback. Commands use the actual accepted revision; responses must match the current game/request generation and cannot regress the accepted revision. The browser never adjudicates a move: only server-supplied `legalMoves` provides sources, destinations, and promotion choices; the FEN parser checks presentation syntax only.

Ordinary requests are credentialed/no-store, with a ten-second deadline and cancellation when their owner disconnects, including body consumption. AI-turn POSTs have no browser deadline because one turn may contain metadata requests and multiple provider attempts; the [provider transport deadlines](providers.md#transport-and-credentials) still apply.

For human and lifecycle commands:

- Conflicts replace the complete authorized snapshot and invalidate stale selection/promotion.
- Rejected moves synchronize through an authorized GET before another submission; failed synchronization keeps the board inspectable and blocked.
- Network, timeout, server, and malformed-response failures retain the identical command and read back state. An unchanged revision remains uncertain; explicit retry reuses its ID, version, and payload. A newer revision prevents the old command committing and can be adopted.
- Access loss clears private state and requires explicit action before bootstrapping another guest. URL navigation cancels obsolete requests and resolves the target through authorization. No game state enters browser persistence.

### AI progression and uncertain responses

Accepted game state, turn activity, and automatic-progression intent are separate. One timer schedules the presentation gap after an accepted active move; at most one AI turn is requested at a time. Provider pauses, terminal results, uncertainty, and disconnection stop scheduling.

Pause and confirmed Stop halt scheduling, invalidate the client request generation, and immediately submit lifecycle commands while the accepted board remains visible. If completion wins the lock, the intent follows authorized conflict snapshots for at most three lifecycle attempts. Confirmation/focus rules belong to the [design system](design-system.md#keyboard-and-chess-interaction).

Failed or conflicting AI turns never trigger an automatic resend, including with the old ID. Read-back may adopt the same game's non-regressing snapshot but leaves progression off. An unchanged revision stays uncertain and blocks fresh turns until explicit Pause or Stop fences it. If a rejected lifecycle command's read-back failed, a later successful same-version read can restore Pause/Stop without releasing AI uncertainty. An unresolved lifecycle command still needs its identical-command retry flow.

### Live attempt progress

While an AI-turn POST is pending, read its private snapshot every 500 ms after the previous progress read completes. These credential-free reads use the ordinary deadline and never overlap. Display invocation metadata only for the same game and unchanged accepted position; the POST still determines accepted position and lifecycle.

Retry labels count recorded invalid responses for the current ply across reservations, excluding provider failures and interruptions. Turn settlement, lifecycle controls, and disconnection cancel progress reads and ignore late results. Failed reads cannot resend a turn. Access loss clears private state. A changed API runtime cancels the turn and invokes paused recovery without acknowledging that runtime from the progress read.

A confirmed provider-auth error invalidates only the affected seat's page-memory key. Replacement preserves the other seat and effective configuration, performs neither discovery nor generation, and requires explicit Retry move or Resume. Remember the corrected failure so historical auth errors cannot invalidate the replacement again.

## Recovery and runtime continuity

Mounting the sandbox checks readiness and discovers the existing guest's unfinished sandbox or reads its private URL. Anonymous discovery returns to entry; readiness does not imply sandbox availability. Creation conflicts and AI Return to game recover the authorized game through the same versioned Pause path.

No recovered active snapshot enables play. Recovery reconciles at most three conflicts, then requires Retry recovery; an uncertain pause retains its original command for identical explicit retry. An already-paused sandbox needs no write, while AI recovery always advances the revision to fence delayed steps. Missing AI keys require page-memory re-entry and explicit continuation; entering them never starts work.

Page exit stops timers and request consumption, clears setup/playback keys (including back-forward-cache navigation), and sends a credential-free keepalive Pause. Delivery is best effort; returning pages always reconcile and fence again. Offline events stop progression; reconnection with the same live page may retain keys but still requires paused recovery and explicit continuation. A stored game may remain active until recovery, and an already-issued call may incur cost; this browser schedules no further turns.

Game API responses expose a UUID `x-neurochess-ai-runtime` header through CORS. The browser acknowledges it on validated session/game reads, explicit lifecycle controls, and AI responses, then echoes it on subsequent AI-turn POSTs. After authorization, a mismatch returns `GAME_CONFLICT` before reservation/provider execution. The browser adopts the new runtime through recovery and awaits explicit continuation.

Direct explicit command clients may omit the header. It is a continuity check, never an authentication capability. A restart during a call leaves its durable reservation for recovery; a restart between turns cannot silently continue an established automatic sequence. This follows the single-API-instance assumption; multiple instances need a shared-generation or routing decision. See [ADR-0011](decisions/0011-ai-page-recovery.md).

## Human turns

AI-versus-human setup supplies the human color; recovery reads it with saved configuration and complete accepted history. Only AI seats need provider credentials. Human input requires the active authorized human turn, progression enabled, and no pending operation. The API independently verifies the persisted seat.

An accepted human move schedules one AI reply; an accepted AI move waits for the human. The AI opens immediately when the human selected Black. Resignation is bound to the configured human color and shares lifecycle invalidation/conflict handling. Recovered games require missing keys and explicit Resume before either side plays. A successful explicit human-command retry can schedule the opponent; reconciliation alone leaves progression off.

Online human moves use the same authoritative command path without provider I/O. The planned room protocol broadcasts accepted state and requires a full authorized snapshot before reconnecting clients process later events; see [realtime architecture](architecture.md#realtime-rooms).

## Replay and telemetry

Terminal replay and PGN use the same authorized full-history verification as snapshots. Replay returns the terminal snapshot and initial FEN; a separate cursor selects verified FEN/SAN/UCI without changing accepted state. PGN export returns canonical text in JSON. Copy and UTF-8 download use identical text; clipboard failure exposes selectable text. Access loss clears loaded private data.

New sandbox URLs retain `/sandbox?game=<uuid>`; legacy `/?game=<uuid>` links remain supported. New game preserves the previous record and private URL. Guest access expires with the existing session; there is no guest history list or retention cleanup. Production retention is an [open product decision](product.md#other-open-decisions).

### Invocation projection

AI snapshots omit `invocations` before any attempt. After authorization, the API projects history from invocation, reservation, and move records within the snapshot's transaction. Reservation revision and move-command identity determine the target ply and whether an attempt produced an accepted move; matching UCI or treating revision as ply is insufficient.

Public fields include color, ply, chronological attempt number across reservations, normalized status/error codes, accepted commentary, latency, and nullable input/output/total token counts. Internal IDs, provider request IDs, copied configuration, and raw diagnostics stay private to the API. Pending/interrupted calls retain unavailable values; only a committed move receives commentary.

Per-move measurements belong to the accepted attempt; earlier calls retain their own measurements in history. No unreported total is inferred. Attempts can progress without advancing the game revision, so unfinished reconciliation compares authoritative chess state separately from metadata. Terminal replay verifies the complete immutable snapshot, including telemetry.

Both AI modes reuse the private archive controller. Replay selection synchronizes commentary and measurements with the selected ply; attempt history remains available for the whole game. Canonical PGN and model context exclude commentary, telemetry, and model identities. [Product](product.md#post-game-experience) and the [roadmap](roadmap.md) define the later Stockfish, pricing, and aggregate analysis scope.
