# ADR-0011: AI controller presence and atomic single stepping

**Status:** Accepted  
**Date:** 2026-09-20

## Context

An AI match must stop when its controlling browser disappears, including between requests. HTTP cancellation and unload events cannot establish presence across tabs, network loss, and API restarts. A paused single step must not expose a temporary active game to another command.

## Decision

- Extend ADR-0010 with one database-backed controller lease per ordinary AI game. The authenticated owner claims it with a page-memory UUID and the expected game revision. This UUID fences controllers; it grants no access without the owner's session. Initial creation installs a 15-second unclaimed lease so abandoned creation also pauses. Only the initial revision can claim an active unclaimed game.
- Heartbeats renew a live matching lease every 3 seconds, using the database clock and a 15-second duration. They cannot revive expired or replaced leases. Check the lease before reserving, before every provider dispatch, and before every outcome. An expired controller cannot commit even if the expiry worker has not run yet. Model thinking can continue indefinitely within the existing operational request deadline while heartbeats arrive; presence is not a chess clock.
- Each API instance sweeps expired leases at startup and every 2 seconds, in bounded batches, under guest-before-game locks. Active games without leases (including pre-migration games) also pause. The worker reconstructs full history and atomically records a versioned pause, invalidates reservations/unfinished attempts, and removes the lease. Paused games with an outstanding step are fenced with a new pause revision too. The worker never calls a provider or holds a key. During total API/database downtime no writes are possible; the first available worker performs overdue pauses. Multiple workers recheck under locks.
- Normal Pause/Resume carries the matching controller UUID. Pause and Stop remain owner-authorized even when a controller is lost. Recovery uses an explicit versioned Pause without a controller UUID, including on already-paused games, to revoke the old controller and outstanding work. Reads never perform recovery. A competing tab first reads privately, then recovers paused; the previous controller's heartbeat/turn fails and it cannot automatically reclaim control. Continuing requires keys and explicit Resume or Next move.
- Next move is a versioned AI execution with `step: true`, requiring a paused stored game and a live lease. Resume the reconstructed aggregate only in memory to obtain legal context and adjudicate one move. Persist the move, receipt, attempts, and final paused (or terminal) position atomically at one new revision. No intermediate active snapshot is stored or returned. Ordinary paused snapshots still expose no playable moves.
- The browser serializes inference, waits for a complete acknowledged response, and delays the next request by the selected speed. Lifecycle requests have a separate lane so Pause/Stop can invalidate in-flight work. Lost acknowledgements preserve command identity and stop dispatch and heartbeats; authorized synchronization followed by an explicit versioned pause resolves uncertainty. This also lets an orphaned turn pause after an API restart, even if the browser can reconnect. No automatic transport retry or lease takeover is allowed. Navigation/pagehide stops requests and heartbeats and clears keys; bfcache restoration also requires recovery and key re-entry.

## Consequences

Presence loss pauses within the lease duration plus a sweep interval under normal service availability. Expiry is a durable fence, not permission to redispatch. Existing retry budgets, receipt identities, Sandbox authority, private replay, and provider-error classification remain intact. Cancellation and recovery do not guarantee that an upstream request avoided a charge.

Stop old API writers, apply the forward controller-lease migration, then start the updated API. Existing ordinary active games recover paused; Sandbox data is untouched. No account credentials, WebSocket room protocol, human-mode UI, or background AI runner is introduced.

## Alternatives considered

- Unload-only pause: unreliable on tab/process termination and network loss.
- In-memory controller registry: loses fencing across instances and restarts.
- Resume/turn/pause requests for stepping: exposes an active game and races other commands.
- Lease expiry followed by inference retry: can duplicate billable upstream work without user direction.
