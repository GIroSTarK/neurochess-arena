# Architecture decision records

Architecture decision records (ADRs) capture decisions that are consequential, cross-cutting, or expensive to reverse. Product behavior belongs in `docs/product.md`; implementation detail that can change locally does not need an ADR.

## Index

| ADR                                                     | Status   | Decision                                                              |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| [0001](0001-typescript-monorepo-and-data-stack.md)      | Accepted | TypeScript monorepo, PostgreSQL, Drizzle, and Better Auth             |
| [0002](0002-deterministic-chess-authority.md)           | Accepted | Deterministic chess engine is authoritative                           |
| [0003](0003-ai-provider-adapter-and-move-contract.md)   | Accepted | Normalize providers behind one move contract                          |
| [0004](0004-bring-your-own-key-security.md)             | Accepted | Session-only by default, encrypted saved keys by opt-in               |
| [0005](0005-zod-runtime-contracts.md)                   | Accepted | Zod 4 validates runtime boundaries and shared contracts               |
| [0006](0006-guest-owned-game-commands.md)               | Accepted | Guest identity, sandbox authority, and atomic game commands           |
| [0007](0007-lifecycle-recovery-and-private-replay.md)   | Accepted | Shared command receipts, paused recovery, and private replay          |
| [0008](0008-tailwind-css-presentation.md)               | Accepted | Tailwind CSS utilities and a semantic theme for the web app           |
| [0009](0009-ai-turn-persistence.md)                     | Accepted | AI seat configuration, invocation records, and leased turn ownership  |
| [0010](0010-ai-paused-stepping-and-retry-accounting.md) | Accepted | Paused AI stepping and invalid-output budgets across reservations     |
| [0011](0011-ai-page-recovery.md)                        | Accepted | AI page recovery, paused revision fencing, and API runtime continuity |

## Reading related decisions

Read decisions for the affected area together with their extensions. An accepted ADR records its original context and scope; references to a later implementation slice are historical, while current delivery status belongs in the [roadmap](../roadmap.md). An extension replaces only the clauses it names; the other guarantees remain binding.

| Area                                | Decision chain     | Current contract                                                                                                          |
| ----------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Guest commands, lifecycle, replay   | 0006 → 0007        | [Guest authorization and shared commands](../game-protocol.md#guest-identity-and-authorization)                           |
| AI reservations, stepping, recovery | 0009 → 0010 → 0011 | [AI execution](../game-protocol.md#ai-turn-execution) and [recovery](../game-protocol.md#recovery-and-runtime-continuity) |
| Provider and credential boundaries  | 0003 + 0004        | [Provider reference](../providers.md) and [credential lifecycle](../architecture.md#credential-lifecycle)                 |

The tables above link each numbered ADR. Use the current contract for implementation details and the ADR chain for the constraints and rationale. Report a disagreement rather than silently preferring an older clause or rewriting an accepted decision.

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
