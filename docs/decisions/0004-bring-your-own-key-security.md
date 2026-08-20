# ADR-0004: Bring-your-own-key security

**Status:** Accepted  
**Date:** 2026-08-15

## Context

Users provide their own API keys for AI providers. These keys can incur cost and grant access to provider accounts, so accidental persistence, logging, exposure to another player, or leakage through browser storage would be severe. The product must support convenient opt-in storage without making persistence the default.

## Decision

### Session-only by default

- Raw keys live only in in-memory browser state and within the backend request that needs to call or query a provider.
- The browser sends them to the Neurochess Arena backend only over HTTPS.
- The backend does not retain them after the request.
- Raw keys are forbidden from `localStorage`, `sessionStorage`, URLs, analytics, logs, traces, error payloads, and game records.
- Refreshing or closing the page clears session-only keys. A recoverable AI game returns paused and requires key re-entry.

### Optional encrypted storage

- Only an authenticated user can explicitly opt in to saving a provider key.
- The Fastify API encrypts the key using an authenticated-encryption construction before persistence.
- PostgreSQL stores ciphertext, nonce/IV, authentication metadata, provider, owner, label, and timestamps—not plaintext.
- The encryption key is stored in the deployment secret manager and never in PostgreSQL or source control.
- The API returns only masked credential metadata and decrypts a key only for an authorized provider operation.
- Users can revoke saved credentials individually and account deletion removes all credential records.

### Operational controls

- Logger and error-reporting configuration must redact credential field names, cookies, authorization headers, OAuth secrets, database URLs, and token-bearing URLs.
- Provider adapters must not attach secret-bearing request objects to thrown errors.
- No player or room participant may read another user's credential metadata or infer a key from game APIs.
- Development fixtures use non-secret placeholders; automated tests must verify redaction and authorization.

## Consequences

- Guests and users who decline storage must re-enter keys after a refresh.
- The backend is a high-trust component and requires TLS, strict access controls, secret rotation, dependency hygiene, and careful observability configuration.
- Losing the deployment encryption key makes saved credentials unrecoverable; exposing it compromises stored credentials. Backup and rotation procedures are required before production.
- Key rotation may require versioned ciphertext so old and new encryption keys can coexist during migration.
- Background AI games cannot use a session-only key after the controlling browser is gone, consistent with the MVP decision to pause those games.

## Alternatives considered

### Browser persistent storage

Rejected because any successful script injection could read long-lived provider keys and users would have weak visibility into persistence.

### Always require users to re-enter keys

Secure but rejected as the only option because registered users explicitly want optional convenience. It remains the default behavior.

### Store plaintext keys in PostgreSQL

Rejected because database read access, backups, administration tools, or accidental queries would directly expose billable credentials.

### Direct browser-to-provider calls

Rejected as the universal architecture because provider browser behavior differs and it would undermine shared validation, normalization, error handling, and telemetry controls.
