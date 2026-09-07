# ADR-0011: AI page recovery and paused revision fencing

**Status:** Accepted  
**Date:** 2026-09-07

## Context

Refreshing either AI mode loses session-only keys. An interrupted request may already have committed, may hold a paused-step reservation, or may not have reached reservation yet. A browser can also remain open while the API restarts between turns. Recovery must preserve accepted history and configuration without silently repeating provider work.

## Decision

- Extend [ADR-0010](0010-ai-paused-stepping-and-retry-accounting.md): an authorized Pause on any paused AI game advances its revision and records the ordinary pause receipt, even without a reservation. This fences delayed requests before reservation without a temporary Resume. Sandbox and human-room lifecycle semantics are unchanged.
- Read saved AI configuration and the fully restored accepted snapshot together through an owner-authorized, read-only transaction. Return only mode, human color when applicable, and effective AI seat parameters. Catalog references, credentials, guest identities, reservations, and provider payloads are excluded.
- Recover active and paused AI games through the shared versioned Pause path. Reconcile at most three conflicts, retain uncertain lifecycle commands for identical explicit retries, and keep play blocked until recovery succeeds. Re-enter each missing AI seat's key in page memory; supplying keys alone never resumes or requests a turn.
- Stop browser timers and abort owned requests on page exit or an offline event. Clear setup and playback keys on page exit, including navigation into the back-forward cache. A credential-free keepalive Pause is best effort; returning pages always reconcile and fence again. Reconnection with the same live page may retain its keys but still requires explicit continuation.
- The API advertises a non-secret runtime UUID in `x-neurochess-ai-runtime`. The browser acknowledges this runtime on validated session/game reads, lifecycle controls, and AI responses, then echoes it on subsequent turns. After authorization, a mismatch returns the existing conflict envelope before reservation or provider execution. The browser adopts the new runtime, recovers paused, and awaits explicit continuation. Direct command callers may omit the header; it is a continuity check, never an authorization capability.

## Consequences

No database migration, background game runner, persisted browser state, or saved-key mechanism is needed. Full-history restoration continues to own draw adjudication. An API restart during a call leaves its durable reservation for explicit recovery; a restart between browser turns cannot silently continue an established automatic sequence.

Page-exit delivery cannot be guaranteed during process termination or lost connectivity. A stored game may remain active until recovery, but this browser sends no further turns. An already-issued external call may still incur cost; revision fencing prevents its late result from changing the accepted position. Runtime continuity follows the existing single-API-instance deployment assumption; multiple instances would need a shared generation or connection-routing decision.

## Alternatives considered

- **Accept paused recovery without a write:** cannot fence a still-running step or a delayed request before reservation.
- **Resume then Pause solely to advance the revision:** temporarily exposes active state and adds another uncertain command boundary.
- **Automatically retry after restart or lease expiry:** can repeat an external call whose outcome is unknown.
