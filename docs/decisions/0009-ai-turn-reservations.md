# ADR-0009: AI turn reservations and explicit crash recovery

**Status:** Superseded by [ADR-0010](0010-ai-failure-policy-and-invocations.md)

**Date:** 2026-09-14

## Context

An AI move spans a database transaction and an external provider request. Accepted command receipts cannot represent work that may never produce a move. Multiple API instances must suppress duplicate dispatches, and a late response must not undo Pause, Stop, resignation, or recovery. A process crash cannot establish whether an upstream request was billed.

## Decision

- Store at most one `ai_turn_reservations` row per game, containing only a server-generated fencing UUID, command UUID, expected revision, state, and creation time. `in_flight` means dispatch may have occurred; `blocked` means execution failed or was interrupted. Neither state is an accepted command receipt. No credentials, prompts, responses, or exceptions belong in this table.
- Reserve inside the existing short READ COMMITTED transaction, locking the valid guest before the game. Establish read access, check accepted IDs/revision, then require ownership, an ordinary AI game, active lifecycle, and the current AI seat. Construct context from verified complete history. Only the transaction that inserted the reservation may dispatch; competing requests with either the same or a different command UUID cannot call a provider.
- Call the injected adapter outside the transaction. Validate its normalized output and submit its UCI move to the same deterministic aggregate used for human moves. Before acceptance, lock and reconstruct again, recheck guest validity, ownership, lifecycle, revision, seat identity/configuration, and the exact reservation UUID/state. Commit the move, position/result, `move` command receipt, and reservation deletion atomically. AI and human moves share the existing receipt kind and accepted-ID namespace.
- Every accepted ordinary-game command invalidates the reservation in its transaction. A lifecycle command uses its own UUID; it cannot claim an outstanding AI command's UUID. Read/discovery operations never clear reservations or change lifecycle. The game lock and revision fence determine the order if a move and Pause race.
- After failed output, cancellation, an adapter exception, or an unsuccessful commit, conservatively mark only that execution's reservation `blocked`. If cleanup itself fails, leave the durable reservation in place. Never release it merely because the caller lost its response. If the commit succeeded but its acknowledgement was lost, the accepted receipt still prevents redispatch.
- Reservations have no expiring lease or automatic takeover. A surviving `in_flight` row after restart is indistinguishable from a live request on another instance. Recover either case through the existing owner-authorized, versioned Pause command, which advances the revision and clears the reservation atomically. Explicit Resume and a new turn command may then authorize another provider call. Abort or human resignation also invalidate outstanding execution. An old result or cleanup cannot affect a subsequent reservation.

## Consequences

There is at most one dispatch per reservation and at most one accepted move for its revision, including across independent instances and restarts. There is **no exactly-once provider billing guarantee across crashes**. Explicit recovery can authorize another billable request whose predecessor's upstream outcome is unknown; recovery never silently resends it. No background worker, process-local mutex, or persistent key is required. Adapters must honor cancellation and retain keys only within the operation.

Tests inject scripted adapters; production composition supplies none and exposes no AI turn route. Invalid-output retries, technical losses, provider-error pauses, durable attempt budgets, and invocation telemetry are the next failure-policy slice. Its logical-turn records must preserve the retry budget across explicit Pause/Resume recovery; clearing an execution reservation must not reset that budget.

The forward migration only adds the reservation table; existing Sandbox/AI games, seats, moves, receipts, and the unfinished-owner index are unchanged. Stop old API writers before applying it and restart with the new code before enabling execution, so every writer invalidates reservations on accepted revisions.

## Alternatives considered

- **Use `game_commands` for pending work:** conflates uncertain upstream execution with accepted state and consumes receipt revisions without an accepted command.
- **Keep a transaction open during inference:** prevents timely lifecycle controls and holds database locks/connections while waiting for a provider.
- **Use a process-local mutex:** cannot coordinate independent instances or survive a restart.
- **Expire a lease and automatically retry:** can repeat a still-running or already-billed upstream call. An explicit versioned recovery action supplies the missing user direction.
