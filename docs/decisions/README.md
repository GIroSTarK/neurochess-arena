# Architecture decision records

Architecture decision records (ADRs) capture decisions that are consequential, cross-cutting, or expensive to reverse. Product behavior belongs in `docs/product.md`; implementation detail that can change locally does not need an ADR.

## Index

| ADR                                                             | Status     | Decision                                                                                 |
| --------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| [0001](0001-typescript-monorepo-and-data-stack.md)              | Accepted   | TypeScript monorepo, PostgreSQL, Drizzle, and Better Auth                                |
| [0002](0002-deterministic-chess-authority.md)                   | Accepted   | Deterministic chess engine is authoritative                                              |
| [0003](0003-ai-provider-adapter-and-move-contract.md)           | Accepted   | Normalize providers behind one move contract                                             |
| [0004](0004-bring-your-own-key-security.md)                     | Accepted   | Session-only by default, encrypted saved keys by opt-in                                  |
| [0005](0005-zod-runtime-contracts.md)                           | Accepted   | Zod 4 validates runtime boundaries and shared contracts                                  |
| [0006](0006-guest-owned-game-commands.md)                       | Accepted   | Guest identity, sandbox authority, and atomic game commands                              |
| [0007](0007-lifecycle-recovery-and-private-replay.md)           | Accepted   | Shared command receipts, paused recovery, and private replay                             |
| [0008](0008-tailwind-css-presentation.md)                       | Accepted   | Tailwind CSS utilities and a semantic theme for the web app                              |
| [0009](0009-ai-turn-reservations.md)                            | Superseded | Database-backed AI reservations and explicit crash recovery                              |
| [0010](0010-ai-failure-policy-and-invocations.md)               | Accepted   | Durable logical-turn budgets and atomic invocation outcomes                              |
| [0011](0011-ai-controller-presence-and-step.md)                 | Accepted   | Controller presence fencing and atomic paused AI steps                                   |
| [0012](0012-independent-sandbox-game-slot.md)                   | Accepted   | Independent unfinished-game slots for Sandbox and public modes                           |
| [0013](0013-server-derived-principals-and-account-lifecycle.md) | Accepted   | Server-derived principals, separate guest/account ownership and lifecycle policies       |
| [0014](0014-encrypted-provider-credentials.md)                  | Accepted   | AES-256-GCM credential envelopes, authenticated context and key-loss/rotation boundaries |
| [0015](0015-saved-credential-dispatch-and-revocation.md)        | Accepted   | Saved credential dispatch authorization, retries and in-flight revocation                |
| [0016](0016-atomic-account-deletion.md)                         | Accepted   | Atomic account deletion, fresh identity checks and in-flight work fencing                |
| [0017](0017-data-router-and-canonical-game-paths.md)            | Accepted   | Data router, canonical private game paths, and navigation lifetime boundaries            |
| [0018](0018-private-room-lifecycle-and-shared-retention.md)     | Accepted   | Private room lifecycle, participant retention, invitations, and shared write ordering    |

## Status values

- `Proposed`: under discussion and not yet binding.
- `Accepted`: current direction for implementation.
- `Superseded`: replaced by a later ADR; retain the historical record.
- `Rejected`: considered but intentionally not selected.

## Template

```markdown
# ADR-NNNN: Decision title

**Status:** Proposed  
**Date:** YYYY-MM-DD

## Context

What forces or constraints require a decision?

## Decision

What will the project do?

## Consequences

What becomes easier, harder, or constrained?

## Alternatives considered

What credible options were not selected and why?
```

Never rewrite an accepted ADR to hide a changed decision. Add a new ADR and mark the old one as superseded.
