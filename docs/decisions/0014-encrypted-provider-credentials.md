# ADR-0014: Versioned authenticated provider-credential envelopes

**Status:** Accepted

**Date:** 2026-10-01

## Context

[ADR-0004](0004-bring-your-own-key-security.md) requires optional account-owned encrypted storage, safe metadata-only reads, server-side cryptography and deployment-managed secrets. The persisted format must detect ciphertext substitution between records, owners or providers and support deliberate future rotation. Management must remain possible after key loss.

## Decision

- Use Node's standard `crypto` AES-256-GCM implementation in the API, a cryptographically random 12-byte nonce per encryption and a 16-byte authentication tag. The database package receives only ciphertext and metadata.
- Store relational `id`, `user_id`, provider, label, nullable masked suffix, creation timestamp, version `1`, key ID, nonce, authentication tag and ciphertext. Binary envelope fields use lowercase hex; ciphertext is bounded to 4096 bytes. The owner foreign key cascades when account cleanup eventually deletes the auth user.
- Authenticate the UTF-8 JSON array `["neurochess-provider-credential", 1, keyId, userId, provider, credentialId]` as additional authenticated data. UUIDs are canonical lowercase before encryption/decryption so PostgreSQL UUID normalization cannot invalidate a saved record. Verify the full tag before returning plaintext; unknown versions/IDs, malformed envelopes, incorrect keys or substituted context fail with a fixed safe error without underlying exception details.
- Configure one key ID and canonical base64-encoded 32-byte key through server-only environment backed by deployment secret storage. IDs use 1–64 ASCII letters, digits, underscore or hyphen. Missing configuration disables saving; incomplete/invalid configuration rejects startup. Neither the auth secret nor a freshly generated startup key substitutes for this key.
- Management never decrypts. Metadata reads select only safe columns; list/revoke/clear remain usable with no encryption key. The internal decrypt primitive is reserved for the separately authorized provider-operation integration, with no HTTP reveal endpoint.
- Serialize management against the same auth-user lock used by session revocation and account commands. Check the exact session after lock acquisition and after every operation, rolling back if a wait outlasts validity. Revoke/clear delete only that account's rows; no tombstone or secret-bearing receipt survives deletion.

## Consequences

Database read access alone does not reveal plaintext, and copying an envelope to another context fails authentication. This does not defend against an attacker controlling the running API and deployment secrets. Labels/suffixes remain untrusted, strictly bounded metadata; they are not evidence that a provider accepted the key.

Key loss makes existing envelopes unrecoverable. Users can still list/delete records and explicitly save replacements. This version supports one configured key, not automatic multi-key rotation. Before production, establish separate key backup/recovery and a reviewed writer-stop re-encryption procedure described in [development](../development.md#saved-credential-api). Never reuse an ID for different key material. Retain old keys as needed to restore older backups; deletion of live rows makes no backup-erasure claim.

Saved credentials confer no game/controller authority. Provider operations remain session-only until the separate integration. The [open decision](../product.md#open-product-decisions) about completion of already-dispatched work after revocation must be resolved before that integration ships.

## Alternatives considered

- Plaintext or reversible encoding without authentication: violates ADR-0004 and permits undetected modification.
- Reuse `BETTER_AUTH_SECRET`: couples provider-key recovery/rotation to auth-secret lifecycle.
- Omit authenticated identity context: allows copying valid ciphertext into another record or provider.
- Implement a key ring and production rotation service now: requires deployment/backup policy outside this milestone; the explicit version/key ID preserves a forward path.
