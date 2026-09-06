# ADR-0009: AI configuration, invocation records, and leased turn reservations

**Status:** Accepted  
**Date:** 2026-09-06

## Context

AI requests outlive a short database transaction and may be duplicated, interrupted, or overtaken by Pause or Abort. Provider calls cannot hold game locks. Persistence must preserve independent seat configuration and attempt telemetry without storing credentials, and a restarted process must not silently repeat a potentially billable request.

## Decision

### Records and compatibility

- Add `games.mode` with `human_vs_human`, `ai_vs_ai`, and `ai_vs_human`. Existing records default to `human_vs_human`; `is_sandbox` remains a separate internal authority marker and requires that mode. This introduces no ordinary human-room creation permission.
- Store each AI seat's provider, dynamic model identifier, and effective temperature, reasoning effort, and maximum output tokens in typed participant columns. An AI seat requires provider/model and no guest identity; human seats have no AI configuration. Both colors may use the same provider/model with different parameters. Resolve supported parameters before insertion; configuration is fixed for the game through the repository interface.
- Store each provider attempt in `model_invocations`, linked to its game and reservation, with a copied effective configuration, sequential attempt number, normalized result/error, optional UCI/commentary, timing, reported token counts, and an adapter-verified response identifier. Attempts are created as `pending` before the provider call. Missing telemetry remains null; reported zero and partially reported counts remain distinct from unavailable usage.
- Use no raw provider payload, arbitrary metadata, credential, request, header, or exception columns. Persistence validates normalized outcomes strictly and reports fixed error codes without input diagnostics. These records remain internal; existing game responses do not expose them. Pricing and cost calculation remain separate work.

### Ownership and duplicate handling

- Extend the existing `GameRepository.write` transaction with AI operations. Keep `READ COMMITTED` and guest-before-game row locks. Reads retain the existing read-only `REPEATABLE READ` interface and require application authorization before disclosure.
- Only the unexpired owning guest can reserve an AI turn. Require an active, non-sandbox AI game with the mode's two-seat composition and an AI seat for the supplied color. The application must restore the authoritative aggregate, verify its side to move, and pass that color; persistence does not derive chess state from FEN or adjudicate moves.
- A reservation stores the expected aggregate revision, color, command UUID, owning guest, and a server-generated execution UUID. The execution UUID identifies one request execution, is separate from the retry-stable command UUID, and is never a browser credential. Every invocation write, renewal, and completion checks the owner, execution UUID, active lifecycle, current revision, and live lease under the game lock.
- PostgreSQL permits one reserved request per game, one reservation per game revision, and one reservation per game/command ID. Composite foreign keys bind reservations to the actual game owner and AI seat and invocations to the same game/reservation.
- After ownership checks, an accepted receipt or previously reserved command ID returns `duplicate`, including changed payloads and terminal/cancelled/abandoned requests. A fresh stale revision returns `conflict`; a competing current request returns `busy` or `recovery_required`. Only `reserved` grants execution rights. Duplicate requests never acquire the original execution UUID or repeat a provider call.
- Existing command IDs also remain unique across command kinds. `hasCommand` recognizes receipts and AI reservations; ordinary `appendCommand` rejects reservation IDs. A completed AI request writes the original command ID into `game_commands`. Reservation creation and attempt recording do not advance the game revision or create accepted receipts.

### Completion and recovery

- Lease durations are server-controlled, between 1 and 300,000 milliseconds, measured with PostgreSQL's clock after lock waits. The executing request may renew only a live lease. The caller must keep it renewed while an attached request is running. This is execution ownership, not a chess clock or a provider-response time control.
- Execute the provider outside `write`. Each reservation permits an initial attempt and at most two retries, each following a recorded `model_invalid` result. A pending attempt, success, provider failure, or third invalid result prevents another automatic attempt in that reservation.
- The application applies a normalized result through the deterministic aggregate and supplies its accepted position to `commitAiTurn`. Persistence requires a matching move for success, a pause for provider failure, or a technical loss after the third invalid attempt. It atomically writes the shared receipt, optional move, aggregate revision/result, and committed reservation. The caller must let failures unwind the transaction. No invocation outcome alone changes chess state.
- Any ordinary accepted position/lifecycle update invalidates outstanding reservations atomically: a live reservation becomes `cancelled`, an expired one becomes `abandoned`, and unresolved invocations become `abandoned` with unknown telemetry. Recorded outcomes remain available as attempt history even if no move was accepted. A late executor cannot record or commit against the new revision.
- Expiry alone never transfers ownership, repeats a provider call, or mutates a GET. After a crash or disconnected request, a fresh turn request reports `recovery_required`. Recovery uses the existing authorized pause command, advancing the revision and abandoning the expired reservation. Resume is explicit, followed by a new command and execution UUID. A user-directed retry begins a new reservation; old attempts remain associated with the old command. Session-only credentials must be re-entered by the future AI request layer.

## Consequences

The unfinished-game index and accepted-command receipts continue to protect sandbox and AI games together. Independent processes coordinate through PostgreSQL; no process-local mutex, background worker, provider SDK, or stored API key is needed. A lease cannot guarantee exactly-once provider billing when a process dies after sending a request; recovery deliberately requires user action instead of automatic replay.

Generate and review the forward migration with Drizzle Kit. Its composite unique indexes must precede the foreign keys referencing them. Existing human sandbox seats, moves, lifecycle receipts, and ownership upgrade unchanged. Unsupported old AI placeholder seats without provider/model configuration fail migration rather than receiving invented configuration. Stop old writers during migration and restart with the reservation-aware repository so every accepted lifecycle command invalidates reservations.

Authenticated ownership, AI HTTP orchestration, browser-presence handling, credential re-entry, and provider adapters are separate roadmap tasks. This decision supplies their persistence primitives and does not expose an AI gameplay endpoint.

## Alternatives considered

- **Hold the game transaction during provider calls:** blocks lifecycle controls and ties lock duration to provider latency.
- **Use a process-local pending flag:** loses ownership on restart and allows duplicate work across processes.
- **Reassign expired reservations automatically:** can repeat a billable call whose outcome is unknown and permits background continuation without the controlling user.
- **Store only successful moves or raw provider JSON:** loses retry/crash evidence or expands the credential and untrusted-data surface.
