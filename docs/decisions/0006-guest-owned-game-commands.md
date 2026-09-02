# ADR-0006: Guest identity and atomic game commands

**Status:** Accepted  
**Date:** 2026-09-02

## Context

Phase 1 needs one guest to play both colors through the real API without creating a public human room. A game ID cannot confer access, concurrent commands cannot append duplicate moves, and restoring only FEN loses repetition history. The existing chess and contract packages must remain independent leaves, while the database package must not depend on either.

## Decision

### Identity and authority

- Bootstrap with `POST /guest-session` before creating games. Game requests without a valid identity fail rather than minting new identities during concurrent creation. Clients serialize their first-use bootstrap.
- Generate a random 256-bit bearer token and store only its SHA-256 digest with an internal guest UUID. High-entropy random tokens do not need password hashing or an additional signing secret; possession is checked against the stored digest, never a client-supplied guest ID.
- Deliver the token in a host-only `__Host-neurochess_guest` cookie with Secure, HttpOnly, SameSite=Strict, Path=/, and a renewed Max-Age. Require the exact configured web Origin on POST requests and use credentialed, exact-origin CORS. No token or digest enters response JSON or logs.
- Use configurable inactivity expiry (24 hours by default). Renew valid sessions without rotation; never revive expired ones. Production guest retention and automated cleanup are separate follow-ups.
- Disable the sandbox by default and reject production enablement. Access to existing sandbox records also requires enabled non-production policy.
- Persist a server-owned `is_sandbox` flag defaulting to false. Sandbox creation assigns the owner to human White and leaves human Black unassigned. Only the sandbox owner receives both-seat control; this bypasses neither turn, human-seat, lifecycle, version, nor legality checks. Ordinary ownership grants no move authority beyond explicitly assigned human seats.

### Persistence and transactions

- Use normalized guest, game, participant, and move tables with typed columns, relational keys, and lifecycle checks. Public modes, provider configuration, accounts, and room membership are not introduced in this slice.
- Enforce one active/paused owned game per guest with a partial unique index. Unique per-game ply, accepted command ID, and move revision constraints protect history. The owner index covers all games this API can create; later room joining must extend the single-game invariant to non-owning participants before that flow ships.
- Keep SQL and transaction operations behind database-owned interfaces. The API composes these with `@neurochess/chess` and converts to `@neurochess/contracts`; neither shared leaf imports the other or infrastructure.
- Use short READ COMMITTED write transactions. Acquire the guest row before the game row, recheck guest validity after lock waits, and hold the game lock through move insertion and position update. Do not use process-local locks as a correctness mechanism.
- Persist newly started games at revision zero. Each accepted move advances the revision once and commits its UCI/SAN/FEN plus the aggregate FEN/PGN, state, result, and reason atomically. Natural completion releases the unfinished slot in that same transaction. Failed writes roll back in full.
- After read authorization, accepted-ID reuse or an expected-version mismatch returns an authorized current snapshot in `409 GAME_CONFLICT`, before checking fresh-command lifecycle/seat rules. Accepted IDs are scoped to a game. Rejected commands do not reserve IDs; clients still use each ID for only one intended command.

### Restoration and snapshots

- Restore the engine from all ordered UCI moves and persisted lifecycle metadata. Never initialize a public game from a client FEN or restore from cached FEN alone.
- Verify persisted aggregate FEN/PGN and move projections against the reconstructed game. Reject corrupt data without returning raw records or repairing it implicitly.
- Read snapshots in read-only REPEATABLE READ transactions to avoid combining a game row from one revision with moves from another. Snapshot reads preserve lifecycle; explicit paused recovery and resume are the next implementation slice.

## Consequences

The four HTTP operations prove the persistence and authority path without adding UI, lifecycle endpoints, replay/export endpoints, providers, accounts, or rooms. PostgreSQL integration tests are mandatory in the normal test/CI baseline; fast unit tests remain separate. Database migration application stays explicit and the bootstrap migration remains unchanged.

Expired guest games are inaccessible but are not yet automatically deleted. A production guest release still requires the documented recovery and retention follow-ups. Development uses localhost for Secure cookies over HTTP, or HTTPS on other hosts; no insecure cookie toggle is added.

## Alternatives considered

- **Create an identity with the first game:** simultaneous cookie-less requests can create separate identities and orphan games when their cookies overwrite each other. Explicit bootstrap makes the prerequisite visible.
- **An in-memory unfinished-game flag or mutex:** cannot enforce invariants across pools, processes, or restarts. PostgreSQL constraints and locks provide the guarantee.
- **Restore cached FEN:** cannot reproduce repetition history, and trusting cached projections would obscure corruption. Replay is the authority.
- **Assign the sandbox guest directly to both seats:** risks carrying both-seat permission into ordinary-game authorization. A unique assigned-guest seat plus explicit server-only sandbox policy keeps the exception isolated.
