# ADR-0013: Server-derived principals and separate account ownership

**Status:** Accepted

**Date:** 2026-09-24

## Context

Game orchestration currently accepts a guest ID resolved from an opaque cookie. Guest-specific validity checks are repeated across reads, creation, controller renewal, and AI command preparation. Maintenance also locks guest rows, but must work after session expiry. Accounts must not accidentally inherit guest ownership, bypass human-seat checks, or weaken concurrency when both cookies are present.

The [product identity policy](../product.md#identity-changes-and-account-linking) keeps guest games separate from accounts. This extends ADR-0006 without changing its guest protocol, ADR-0007's receipts/recovery, ADR-0010's retry budgets, ADR-0011's presence fencing, or ADR-0012's independent Sandbox slot.

## Decision

- Use a small server-only discriminated `Principal` at the API service boundary. Only the guest variant exists initially. Add the account variant with actual Better Auth session validation; never accept a client-supplied account or guest ID as authentication. A principal identifies a subject, not a timeless grant of access.
- Keep guest cookie parsing/renewal in `guests`, current identity validity and lock semantics in `identity`, game ownership/seat permissions in `games`, and SQL in `packages/database`. Do not create a universal identity framework or put internal principals in transport contracts.
- Require a currently valid principal on reads. Lock and recheck identity before locking a game for commands, creation, controller renewal, and each AI dispatch/outcome. Retain the database clock and post-lock expiry check. Credentials never enter persisted game records, and external provider calls remain outside these short transactions.
- Keep a distinct trusted-maintenance lock operation for presence expiry and discarded-attempt cleanup. It uses server-derived identity references, follows the same lock order, and deliberately tolerates expiry. It grants no user-command or provider-call authority; reservation and game fences still govern cleanup.
- On account-capable public routes, resolve one identity with account precedence and no silent guest fallback for failed account authentication. Guest authority is never combined with account authority. Explicitly guest-only Sandbox keeps its existing development gate and cookie. The concrete account resolver ships with authentication; enabling account gameplay waits for account ownership support.
- Account persistence will use normalized relational owner and human-seat references, with exactly one owner and database-enforced unfinished limits. Usernames and email addresses are not permission keys. Ownership permits lifecycle control, not moves for an AI or another human. Guest ownership and assignments are never transferred at sign-in.
- Preserve paused recovery, page-owned secrets, and controller lifetimes on identity transitions as defined by the product. Shared human rooms must extend unfinished-slot enforcement to non-owning participants in Phase 4; owner uniqueness alone cannot implement that requirement.

## Existing persistence assumptions to carry forward

| Boundary                                           | Guest-specific assumption retained until account ownership work                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guests/service.ts`, `identity/validity.ts`        | Cookie hashes resolve internal UUIDs; renewal never revives expiry; validity uses the database clock.                                                                 |
| `games/service.ts`, `games/authorization.ts`       | Creation/discovery use the guest owner and explicit ordinary/Sandbox scope; ordinary AI reads are owner-only; legacy human seats have separate read/move permissions. |
| `games/configuration.ts`                           | AI seats have no guest assignment; ordinary human seats match the owner; Sandbox assigns White and leaves Black unassigned.                                           |
| `games/ai-turn.ts`, `games/controller-presence.ts` | Command preparation rechecks identity/authority; controller UUIDs confer no ownership; cleanup tolerates expired identities.                                          |
| `packages/database/src/game-repository.ts`         | Guest-before-game row locks, valid-guest reads, guest-scoped unfinished queries, and owner guest IDs from presence candidates.                                        |
| Database schema                                    | Non-null guest owner, guest human-seat references, and the active/paused `(owner_guest_session_id, is_sandbox)` unique index.                                         |

The groundwork changes none of these SQL operations or constraints. Account ownership must update all of them together, including controller expiry and cleanup, through reviewed forward migrations.

## Consequences

Guest creation, private reads/replay, seat authorization, concurrency, retries, and independent Sandbox limits retain their existing behavior. Authentication and ownership can evolve separately without exposing a partially working account game flow. No account routes, migrations, provider requests, or UI are added by the groundwork.

The [username/avatar](../product.md#usernames-and-avatars), [history/deletion](../product.md#private-history-and-deletion), and [credential lifecycle](../architecture.md#credential-lifecycle) policies are canonical inputs to later account work. Production guest retention, backup retention, and Phase 4 shared-game deletion remain explicit decisions rather than assumptions in this boundary.

## Alternatives considered

- **Transfer guest games at sign-in:** conflicts with the accepted separation policy and introduces consent, conflicting-slot, and controller-transfer races.
- **Treat any owner ID as a principal:** permits accidental identity-type collisions and obscures session validity and provenance.
- **Generalize every repository method before account tables exist:** creates speculative persistence APIs without a schema or actual account validity checks. Keep the existing SQL until the account ownership change can verify both paths.
- **Use ordinary authentication for cleanup:** expiry would prevent authoritative pausing and discarded-result fencing after the browser loses access.
