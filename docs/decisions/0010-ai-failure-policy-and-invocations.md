# ADR-0010: Durable AI retry budgets and invocation outcomes

**Status:** Accepted

**Date:** 2026-09-14

## Context

Pause/Resume changes the game revision without changing the chess turn. An execution reservation alone cannot preserve the invalid-output budget or account for attempts that never produce a move. Provider failures must pause without becoming chess losses.

## Decision

Retain ADR-0009's reservation fencing, guest-before-game locks, accepted-command namespace, authorization, and explicit recovery rules. Replace its interim single-dispatch and blocked-output policy with the following durable attempt policy.

- Extend [ADR-0009](0009-ai-turn-reservations.md) with an `ai_turns` record unique by game and next ply. Its invalid-output count survives reservation deletion, lifecycle commands, and restarts. A completed move links the logical turn and all its attempts to that move. Repeated positions at different plies have independent budgets.
- Before each dispatch, persist an `in_flight` invocation and advance the logical turn's attempt sequence in a short guest-before-game transaction. Keep the execution reservation across automatic invalid-output retries. Recheck authorization, revision, reservation, and seat configuration before every dispatch and every outcome.
- Persist each known invalid output and increment its budget atomically. The first two permit another attempt; the third calls the trusted domain technical-loss hook and commits a `technical_loss` receipt, result, and attempt together. Cancellation after receiving an invalid output pauses further retries without erasing that output's count or preventing the third-output loss. This receipt kind is internal, never a client lifecycle action.
- Provider failures, exceptions, and cancellation after dispatch commit a safe failure attempt and an ordinary `pause` receipt under the AI command ID. They return the paused snapshot and never consume invalid-output budget. Explicit Resume and a new versioned turn command authorize retry. An already-aborted signal before reservation dispatches nothing.
- Persist the provider/model and exact parameter object supplied to the adapter, service-measured duration, independently nullable reported token counts, and normalized error code/reason. Keep missing usage distinct from reported zero and from a reported object with unknown counts. Only the accepted attempt retains optional viewer commentary; it never enters canonical PGN or later prompts. Omit commentary that echoes the supplied key or contains a NUL unsupported by PostgreSQL text, without rejecting the legal move. Do not persist prompts, raw responses, exceptions, credentials, or upstream request IDs.
- Lifecycle invalidation marks unfinished attempts `interrupted` and deletes only the reservation. Their upstream outcome and usage remain unknown. A late result may finalize its own attempt as `discarded`, retaining safe measurements/errors but never altering a budget, move, lifecycle, or newer reservation. Reads remain private, runtime-validated, and read-only.
- Failed outcome transactions roll back their attempt/counter and command writes together. Cleanup blocks the execution; recovery marks any unresolved attempt interrupted. A committed outcome with a lost acknowledgement remains deduplicated. Neither an unresolved dispatch nor a database rollback proves an upstream call was unbilled; there is no automatic takeover or exactly-once billing guarantee.

## Consequences

The invalid-output budget belongs to chess history rather than requests or revisions. Invocation sequence numbers include provider failures and interrupted work; they are not invalid-output counts. Operational metadata can change without a chess revision, so consumers read it explicitly instead of treating the game version as its cache key.

Malformed model output is `model_invalid`; a malformed adapter envelope or usage record is `provider_unavailable/invalid_response`. Adapters must normalize provider content before returning it and must not hide retries. Capability filtering and the HTTP credential boundary remain separate work; this service records the parameters it actually supplies to the injected adapter.

Stop old API writers before applying the forward migration and restart with the updated code. Existing games and reservations are retained; historical invocations are unknown and are not invented. Existing reservations still require explicit recovery before new dispatch.

## Alternatives considered

- **Budget per request or revision:** refresh and Pause/Resume would reset the model's allowance.
- **Only record successful moves:** loses provider failures, retry counts, and uncertain dispatches.
- **Keep provider calls inside the outcome transaction:** blocks lifecycle controls and cannot make the upstream operation transactional.
- **Persist raw upstream data for recovery:** violates credential minimization and cannot establish safe automatic replay.
