# ADR-0013: Server-derived principals and separate account ownership

**Status:** Accepted

**Date:** 2026-09-30

**Scope update (2026-10-27):** [ADR-0018](0018-private-room-lifecycle-and-shared-retention.md) resolves the room-participant slot and shared-retention prerequisites below and adds the shared-room gate before identity locks for affected writes. The principal and guest/account separation decisions remain binding; [current room write ordering](../architecture/rooms.md#shared-room-write-order) defines the extended lock protocol.

## Context

Guest cookie authentication, game authorization, expiry checks, and controller cleanup currently share guest-specific assumptions. Account support must not make a client ID an identity, combine account and guest authority, reset concurrency fences, or disable cleanup when a session expires. ADRs 0006, 0007, 0010, 0011, and 0012 remain binding.

## Decision

- Define a small API-owned `Principal` with an explicit identity kind, separate from cookies, tokens, HTTP requests, and transport contracts. Guest authentication derives its guest ID from the verified token digest. Only the implemented guest variant is available initially; add account identity through validated server sessions, never a request-supplied user ID or a placeholder account resolver.
- Keep token verification and cookie renewal in `guests`. Centralize principal validity and identity locking in `identity`; keep ownership, read permissions, and human-seat permissions in game authorization. Ownership alone grants no human authority over an AI seat. Sandbox's development-only owner exception remains restricted to human seats.
- Preserve the current SQL, schema, guest expiry, and identity-before-game lock order. User commands must require a valid identity after acquiring its lock; AI execution reuses that check at reservation, dispatch/retry, and outcome boundaries. Read authorization still precedes full-history restoration and conflict snapshots.
- Distinguish user authority from cleanup. The absence sweeper derives the owner from persisted game metadata and locks that identity even after expiry. AI cleanup uses the server's existing reservation/attempt identity under the same locks. These paths may pause or discard work without an active session, but cannot renew identity, dispatch providers, or resurrect deleted data.
- Extend ownership with normalized account/guest references and database constraints when account gameplay ships. Update principal validity, owner/seat mappings, creation/configuration restoration, unfinished-game lookups, and the sweeper's stored-owner projection together. Retain accepted-command receipts and full-history restoration. Do not add polymorphic JSON owners or a universal identity framework.
- Guest games and accounts remain separate under the [product transition policy](../product.md#identity-changes-and-account-linking). Valid account sessions take precedence on public account-capable routes; account operations cannot inherit guest authority or silently bootstrap a guest after expiry. Sandbox remains explicitly guest-only. Username, avatar, linking, and history/deletion policies live in the [product specification](../product.md#usernames-and-avatars), not authentication-library defaults.
- Keep one unfinished public game per identity and an independent guest Sandbox slot. The current owner index cannot enforce the limit for a room's non-owning human participant. Phase 4 must extend slot reservation and decide shared-participant retention/deletion before room joining ships.

## Consequences

Game services no longer depend on the guest authentication service's principal type or cookie implementation. The explicit kind prevents an unsupported identity from matching a guest ID accidentally. The boundary introduces no account route, session resolver, migration, provider operation, or UI flow.

Guest-specific storage remains visible where it is still the actual contract: repository guest expiry/locks, owner and participant columns, creation/configuration projections, scoped discovery, and controller sweep candidates. Account support must change these together rather than treating a type rename as complete authorization. No guest import/transfer or identity-merging migration is authorized by this decision.

## Alternatives considered

- Pass cookies or authentication-library session objects into game services: couples permissions to transport and carries unnecessary secrets.
- Add an account-shaped client ID now: implies authentication and ownership guarantees that do not exist.
- Generalize every repository operation before account persistence exists: creates speculative branches and risks changing guest SQL without a consumer.
- Require an active session for background cleanup: leaves abandoned active games and uncertain attempts unhandled after identity expiry.
- Merge guest/account ownership at sign-in: contradicts the confirmed guest-separation policy and would require consent, slot-conflict, seat-transfer, and old-controller rules.
