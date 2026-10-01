# ADR-0015: Saved credential dispatch and revocation

**Status:** Accepted

**Date:** 2026-10-01

## Context

[ADR-0014](0014-encrypted-provider-credentials.md) establishes encrypted storage but leaves provider use and in-flight revocation unresolved. The [product policy](../product.md#saved-credential-use-and-revocation) now permits an already-dispatched result to complete while all other authority remains valid. This extends ADRs 0004, 0010, 0011 and 0014 without changing their storage, retry, or controller rules.

## Decision

- Discovery and turn bodies accept exactly one of `apiKey` or `credentialId`. Preserve the session-only shape. References are account-scoped UUIDs; the provider for inference comes exclusively from the persisted AI seat.
- Resolve credentials only after account/profile authorization and, for turns, game ownership, AI-seat, revision, reservation and live-controller checks. Read only the encrypted envelope matching the authenticated owner, ID and provider in the same short identity-before-game transaction. Recheck session validity before API-only decryption. No nested credential-management transaction is needed.
- Resolve independently for discovery and every inference attempt. Before each upstream HTTP request, including another catalog page, reauthorize and compare the current encrypted envelope to the one resolved for that operation. Missing/replaced envelopes stop the dispatch; revoking then reusing an ID cannot change the key within an operation. The short authorization transaction determines dispatch ordering with revocation; network work begins after its release and never holds those locks.
- Treat unavailable credentials as the existing safe `provider_auth` failure, with no distinction that reveals foreign records or cryptographic diagnostics. A turn commits the ordinary paused snapshot and normalized failure attempt with no reported usage. Preserve previously observed invalid-output counts and require user-directed continuation.
- Credential revocation does not invalidate the game reservation or discard already-dispatched outcomes. Every outcome still rechecks the account session, game/seat, revision, reservation and controller. No credential or reference enters configuration, receipts, reservations, snapshots or invocation records. Plaintext exists only in the provider-operation scope; clear its access object after completion and retain no credential cache.

## Consequences

Users may see one already-dispatched result complete after revocation. Revocation cannot cancel charges, and credential storage never supplies a background runner or automatic recovery. The optional encryption configuration must be available to use saved references; session-only operations and metadata management remain usable without it. No schema migration is needed. Browser credential selection remains a separate delivery milestone in the [roadmap](../roadmap.md#phase-3--accounts-encrypted-credentials-and-history).

## Alternatives considered

- Decrypt once at the HTTP boundary: precedes game/seat authorization and retains stale authority across retries.
- Hold locks throughout provider requests: prevents timely lifecycle/revocation operations without making external work transactional.
- Discard every result after credential revocation: a valid alternative rejected by the accepted product policy; account/session/controller fences still apply.
