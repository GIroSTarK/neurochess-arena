# ADR-0010: Paused AI stepping and retry accounting across reservations

**Status:** Accepted  
**Date:** 2026-09-06

Extended by [ADR-0011](0011-ai-page-recovery.md): Pause also fences paused AI games without an outstanding reservation, including requests delayed before reservation.

## Context

[ADR-0009](0009-ai-turn-persistence.md) initially allows active reservations and up to three attempts per reservation. A provider failure or lifecycle recovery creates a new reservation, which must not erase earlier invalid responses for the same chess turn. Next move also needs to execute from paused state without exposing an active game during provider I/O.

## Decision

- Extend the existing `ai-turn` command to active or paused AI seats. Its body and ownership checks are unchanged. A paused request grants one step, including any remaining automatic retries. The application resumes only its restored in-memory aggregate for canonical context and move validation, then pauses an unfinished result before committing. Persistence requires unfinished success to retain the reserved revision's lifecycle; terminal outcomes remain authoritative domain results.
- Count the current seat's recorded `model_invalid` invocations in reservations at or after the last accepted move revision. Existing indexed move, reservation, and invocation records provide the durable budget without a new column or migration. Reservation-local attempt numbers retain their meaning and constraints. Provider errors and unresolved attempts never consume the budget; recorded invalid results still count if a subsequent lifecycle change cancelled their reservation.
- Enforce the threshold at both invocation creation and turn completion. After the third invalid response, record the outcome and apply `recordTechnicalLoss` in the same transaction. Only an accepted move resets the budget. A user-directed retry uses a new command and execution UUID at the current revision; old IDs never regain execution rights.
- Keep Pause, Resume, and Stop on the shared lifecycle path, with Stop represented by `abort`. Pause on an already-paused AI game is accepted only to invalidate an outstanding reservation, including an expired one. It preserves the domain snapshot while advancing the revision and writing a pause receipt. Resume also invalidates a pending step and never launches a provider request.
- Preserve guest-before-game locking, lease ownership, atomic receipts, and private reads. Any lifecycle command that wins the lock invalidates pending results and abandons unresolved attempts. If completion wins, a stale lifecycle command conflicts with the accepted snapshot. Interrupted work requires explicit pause recovery before a fresh step or resume; no automatic takeover occurs.

## Consequences

Provider failures and repeated pause/resume cannot replenish the invalid-output budget. Paused stepping has no durable intermediate active state or extra lifecycle receipts. All games retain the existing single unfinished slot and full-history chess restoration. AI browser controls, provider adapters, credential transport, and telemetry presentation remain separate roadmap work.

Deploy the updated API writers together so older writers cannot apply the previous reservation-local budget. No database DDL changes are needed.

## Alternatives considered

- **Persist Resume before a step and Pause afterward:** exposes active state during provider I/O and can leave the game active after an interruption.
- **Reset the budget for every reservation:** permits repeated provider failures or lifecycle changes to evade the third-invalid technical loss.
- **Persist a mutable retry counter:** duplicates normalized invocation history and introduces another value that must remain consistent across rollback and recovery.
