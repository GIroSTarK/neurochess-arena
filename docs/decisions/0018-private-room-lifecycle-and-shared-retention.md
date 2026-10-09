# ADR-0018: Private room lifecycle and shared retention

**Status:** Accepted  
**Date:** 2026-10-09

## Context

Private human rooms add a second independent principal to a game. Owner-only unfinished indexes cannot reserve the opponent's public slot, and deleting an owner's games would erase the opponent's promised history. The current account-deletion adapter acquires the auth-user lock before application cleanup. Adding an opponent lock inside that cleanup can deadlock simultaneous deletions or a command already holding a game lock.

The product already requires private invitation joining, owner-selected color, reconnection without a gameplay deadline, owner closure as `aborted`, and history for registered participants. It leaves waiting, invitation transport, shared deletion, and cleanup eligibility unresolved. Existing AI/Sandbox recovery issues a Pause; a human room needs to preserve its lifecycle through transport failure.

## Decision

The canonical [product policies](../product.md#human-versus-human), [shared retention rules](../product.md#shared-room-retention), [architecture protocol](../architecture.md#realtime-rooms), and [interaction guidance](../design-system.md#private-room-interaction) contain the detailed matrices and boundaries. These decisions apply together:

| Area                           | Decision                                                                                                                                        | Consequence                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Waiting and admission          | Standard-position `paused` game plus waiting room metadata; creation reserves the owner, atomic join seats the opponent and activates           | A waiting room occupies the public slot; owner Black still waits for White's first move                   |
| Creation retries               | One server-issued operation per account, valid for ten minutes and independent of game cleanup                                                  | Deleted, expired, or replaced results never turn a retry into a new room                                  |
| Lifecycle and authority        | Presence is independent; either player moves/resigns only their own seat, only the owner closes, no Pause/Resume or seat replacement            | Disconnect/restart never supplies a chess result; expired identities still lose access                    |
| Shared history                 | One canonical game with independent account retained-access records and temporary guest participation                                           | Deleting/clearing history removes only the requester's access, including direct replay/PGN                |
| Account deletion and ownership | Abort unfinished owned or joined rooms, remove identifying bindings, never transfer ownership, preserve any opponent entitlement                | Anonymized terminal rooms may be ownerless; solo-game ownership and physical deletion stay unchanged      |
| Last-access cleanup            | Delete terminal records when no account entitlement or valid guest remains; sweep guest-only expiry on startup/periodically with no extra grace | Guest expiry immediately denies access but does not automatically abort unfinished play                   |
| Invitations and browser entry  | Single-seat 32-byte random secret, digest-only storage, owner revocation/replacement, fragment-to-memory entry and POST submission              | No pre-join private preview; signing in outside the entry flow requires reopening/pasting the invitation  |
| Transport and locking          | HTTP commands, cookie-authenticated WebSocket snapshots/events, and a database shared-room write gate before identity locks                     | Native browser connections need a validated identity expectation; short room writes serialize for the MVP |

### Concurrency and retained ownership

Separate three responsibilities: database-unique slots reserve unfinished participation; the owner administers the room; retained access permits terminal history/replay. Establish account entitlements at seating so completion never needs to insert a peer identity reference. Removing access cannot be bypassed through ownership, old receipts, or invitations.

The [lock protocol](../architecture.md#shared-room-write-order) uses one transaction-scoped PostgreSQL gate before requester identity and ordered game locks. Account deletion must acquire it before the existing outer auth-user lock, preserving that connection, authoritative session/freshness checks, and atomic rollback. Never acquire peer locks after requester/game locks. Solo writers keep their existing order and never acquire the gate afterward. This avoids opposing deletion cycles while database uniqueness handles cross-mode slot races.

Deletion covers every account association, including hidden history, and removes identity bindings without a deleted-account tombstone. Only terminal human rooms may become ownerless. Guest-bound cleanup runs separately with gate → guest → game locks so expiry cannot race renewal; account-only last-access removal purges in its transaction. The [retention policy](../product.md#shared-room-retention) defines both-account deletion, guest-only access, and physical cleanup.

### Invitations, transport, and recovery

The [invitation policy](../product.md#invitations-and-entry) defines digest-only admission, bounded status resolution, `/rooms` and `/rooms/join#invite=…`, secret scrubbing, and explicit reopening after sign-in. The canonical game address remains `/games/:gameId`; neither UUIDs nor invitations grant spectator access.

Creation operations have a separate lifetime from invitations and games. The [persistence contract](../architecture.md#shared-room-persistence-and-access) retains one ten-minute pending/consumed operation per account outside game cascades. A deleted result becomes unavailable; unknown, expired, or replaced operations are rejected, never treated as fresh creation. Account deletion removes the operation. This prevents a delayed retry from recreating a physically deleted room without retaining unbounded receipts or expiring waiting rooms.

The [transport contract](../architecture.md#room-transport-and-browser-entry) uses cookie authority plus subscription identity expectations, continuing authorization, and revision reconciliation. Expectations reject mismatches; they cannot grant identity. Human recovery synchronizes without AI leases, credentials, or Pause/Resume. Lost publication after commit must remain recoverable even without a later move.

### Relationship to accepted decisions

This record extends [ADR-0012](0012-independent-sandbox-game-slot.md) and [ADR-0013](0013-server-derived-principals-and-account-lifecycle.md) to non-owner slot reservations and participant retention. It adds a shared-room exception to [ADR-0016](0016-atomic-account-deletion.md)'s owned-game physical deletion and prepends the room gate to deletion's lock order. It scopes the recovery wording in [ADR-0007](0007-lifecycle-recovery-and-private-replay.md) and [ADR-0017](0017-data-router-and-canonical-game-paths.md) to AI/Sandbox while retaining their command, privacy, canonical-path, and browser-lifetime contracts. Their other decisions remain in force; their historical records remain unchanged.

## Consequences

One participant cannot erase the other's history or take over their seat. History deletion is an access removal, so confirmation copy must distinguish it from erasing a shared record. Account deletion removes identifying bindings but cannot recall downloaded PGNs, earlier delivered views, or external backups. Expired guests cannot return, and the owner must explicitly close an unfinished room to free its slots if no further play is possible.

The shared gate is deliberately coarse: unrelated room writes and account/history deletion can queue behind each other, including a large clear. Read-only access, solo gameplay, and provider calls do not acquire it. This bounds concurrency design for the single-instance MVP while preserving database arbitration. Finer-grained locking or horizontal socket distribution requires a separate review rather than a local change to lock order.

Forward migrations must preserve existing games and replace slot guarantees without a gap. Public joins depend on both participant reservations and shared deletion/retention being implemented and tested. Old writers must stop before the schema and locking protocol change. This does not select a WebSocket package, production guest inactivity duration, solo guest cleanup policy, backup policy, or deployment provider.

## Alternatives considered

| Alternative                                                                      | Why it was not selected                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete the shared record for everyone when either account clears history         | Simpler cascades, but contradicts independent participant history and lets one player remove the other's replay                                                               |
| Copy the game into a separate archive for each participant                       | Separates deletion, but duplicates canonical moves/results and complicates synchronization and anonymization                                                                  |
| Preserve owner control over all history, or transfer ownership on deletion       | Conflates room administration with retention, changes permissions, and still needs a policy for the other participant                                                         |
| Pause on every human disconnect or use a reconnect deadline                      | Couples transport to chess lifecycle and adds recovery/forfeiture behavior outside the agreed MVP                                                                             |
| Add opponent locks to the existing requester-then-game path                      | Can invert the established auth/game order; sorted multi-identity locking would require discovering and revalidating a changing set before auth deletion takes its first lock |
| Store invitation plaintext, put it in query/return URLs, or persist it for OAuth | Makes reload easier but extends a secret's exposure beyond the bounded entry flow; digest-only storage and explicit reopening keep that lifetime clear                        |

## Implementation requirements

Implement this contract through the subsequent Phase 4 PRs. Track delivery in the [roadmap](../roadmap.md#phase-4--private-online-human-games).

Later behavior PRs must prove the product matrices and architecture's concurrency cases, especially simultaneous account deletion, clear versus either player's completion, guest cleanup versus renewal, and creation retries after physical cleanup or expiry. They must also cover private authorization, lost snapshot/publication recovery, invitation/auth-return lifetimes, and accessible two-browser journeys.
