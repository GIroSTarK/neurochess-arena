# ADR-0016: Atomic account deletion

**Status:** Accepted

**Date:** 2026-10-03

## Context

Auth-user deletion alone neither removes account-owned games nor cleans recovery records without foreign keys. Provider outcomes, commands and authentication operations may already be in flight. Email-only verification JWTs could verify a newly registered account after the original account is deleted.

## Decision

- Expose one strict, origin-protected `/api/auth/delete-account` operation with explicit confirmation and expected-account matching. Keep Better Auth's built-in deletion disabled. Follow the [product identity recheck policy](../product.md#private-history-and-deletion) for every sign-in method, including accounts without completed profiles.
- Share the existing auth-user lock and connection with Better Auth's authoritative session check and application cleanup. Disable session renewal for deletion. Delete owned games, account-bound recovery rows and the auth user in one PostgreSQL transaction; use existing cascades for dependent rows. Check session validity/freshness after lock waits, including the final cascade. Roll back the whole operation on failure, and emit cookie removal only after commit.
- Retain the existing identity-before-game fences for commands, controller presence and provider execution. Deletion does not wait for upstream inference; its result cannot recreate deleted rows or start an invalid-output retry.
- Bind email-verification JWTs to the immutable account UUID and verify under the account lock. Remove reset records explicitly and serialize reset initiation with deletion. No tombstones or account identifiers remain solely to invalidate old links.
- Clear the browser identity lifetime before deletion starts. Acknowledge success only from the deletion response; session loss cannot distinguish successful deletion from revocation. Repeated requests with deleted sessions fail authentication without falling back to guests.

## Consequences

No schema migration is needed. Previously issued verification links without an account UUID are rejected; users must request a new link when this version is deployed. Stop old API writers before replacing them so all instances enforce the same verification and reset-initiation rules. New registration creates a separate identity. External backup deletion is not implemented, and shared-room retention remains a prerequisite for Phase 4.

## Alternatives considered

- Enable library deletion directly: bypasses application cleanup and misses recovery rows.
- Delete in several independent commits: can leave a live account partially removed.
- Hold the account lock while waiting for providers: delays deletion and cannot make upstream work transactional.
- Treat a missing session as deletion confirmation: misreports network failures and ordinary session revocation.
