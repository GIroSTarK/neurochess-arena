# ADR-0014: Versioned authenticated provider credential encryption

**Status:** Accepted

**Date:** 2026-09-26

## Context

[ADR-0004](0004-bring-your-own-key-security.md) requires account-only, explicit
opt-in provider-key storage with authenticated encryption and external key
management. The storage format must reject swapped records and permit future
key rotation without exposing plaintext to PostgreSQL or management clients.

## Decision

- Encrypt in the API with Node's AES-256-GCM, a fresh cryptographically random
  12-byte nonce for every save, and a full 16-byte authentication tag.
- Version 1 authenticates the UTF-8 JSON tuple
  `["neurochess/provider-credential", 1, keyId, userId, provider, credentialId]`
  as additional authenticated data. The UUID is generated before encryption;
  owner and provider come from the authorized account and validated request.
- Store separate bounded relational columns for version, key ID, lowercase
  hex nonce/tag/ciphertext, owner, provider, label, nullable masked suffix, and
  creation time. The owner foreign key cascades; account deletion remains
  unavailable until its complete cleanup flow is implemented.
- Configure an active key ID and a bounded keyring through server secret
  storage, independently of the auth secret. Saves use the active key;
  decryption requires an explicitly configured matching ID. Unknown versions,
  malformed envelopes, wrong keys/contexts, and authentication failures have
  one fixed, secret-free failure. No plaintext is released before tag verification.
- Management reads select metadata only. There is no reveal endpoint and no
  management decryption. Provider use remains an independently authorized
  boundary, following the accepted [revocation policy](../architecture.md#saved-credential).

## Consequences

Retaining older keys alongside the active key permits controlled re-encryption,
but switching the active ID alone does not rotate existing rows. Key loss makes
the corresponding keys unrecoverable; users can still list metadata and revoke
or clear records without decryption. Operational rotation and backup procedures
must follow the [credential setup guidance](../development.md#saved-provider-credentials).

Both keyring settings absent disables new saves; partial or invalid settings
prevent API startup. There is no plaintext or auth-secret fallback. Encryption
does not protect against a compromised running API with access to the keyring.

## Alternatives considered

- A single unversioned encryption secret would make loss and rotation harder
  to manage and leave no explicit format evolution boundary.
- Encryption without authenticated record context would permit valid
  ciphertext to be transplanted between owners, providers, or record IDs.
- A managed envelope-encryption service remains a possible deployment choice;
  adding its operational dependency is unnecessary for this storage milestone.
