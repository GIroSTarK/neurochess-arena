# Development guide

Setup and maintenance instructions. [Product](product.md) defines behavior, [architecture](architecture.md) defines boundaries, and the [roadmap](roadmap.md) records implementation status. Read the references relevant to the task rather than the entire documentation set.

## Task navigation

| Task                                             | Read first                                                                                                                                                                          | Detailed contract or workflow                                                                                                                                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Run, configure, or migrate locally               | This guide                                                                                                                                                                          | [Verification requirements](testing.md#required-checks)                                                                                                                                                                                    |
| Change chess rules or restoration                | [Product draw policy](product.md#automatic-draw-policy), [domain boundary](architecture.md#deterministic-domain-and-core-contracts)                                                 | [Focused chess checks](#chess-domain-development), [ADR-0002](decisions/0002-deterministic-chess-authority.md)                                                                                                                             |
| Change commands, persistence, retry, or recovery | [Game protocol](game-protocol.md)                                                                                                                                                   | [Related decision chains](decisions/README.md#reading-related-decisions), [integration tests](testing.md#postgresql-integration-tests)                                                                                                     |
| Add or adjust provider behavior                  | [Provider reference](providers.md)                                                                                                                                                  | [Provider contract tests](testing.md#provider-contract-tests), [ADR-0003](decisions/0003-ai-provider-adapter-and-move-contract.md), [ADR-0004](decisions/0004-bring-your-own-key-security.md)                                              |
| Change web controls or layout                    | [Design system](design-system.md), affected [gameplay walkthrough](gameplay.md)                                                                                                     | [Browser tests](testing.md#browser-tests); [game synchronization](game-protocol.md#browser-command-synchronization) when commands are affected                                                                                             |
| Implement accounts, saved keys, or history       | [Roles](product.md#roles), [Phase 3 decisions](product.md#before-phase-3--accounts-and-deletion), [authentication](architecture.md#authentication-and-guest-sessions)               | [Credential lifecycle](architecture.md#credential-lifecycle), [ADR-0001](decisions/0001-typescript-monorepo-and-data-stack.md), [ADR-0004](decisions/0004-bring-your-own-key-security.md), existing [ownership/commands](game-protocol.md) |
| Implement private rooms                          | [Human games](product.md#human-versus-human), [guest reconnection decision](product.md#before-phase-4--guest-reconnection), [realtime architecture](architecture.md#realtime-rooms) | [ADR-0006](decisions/0006-guest-owned-game-commands.md) participant-limit extension, shared [game protocol](game-protocol.md)                                                                                                              |
| Implement analysis or telemetry totals           | [Product live/post-game scope](product.md#live-game-experience), [Stockfish boundary](architecture.md#stockfish-worker)                                                             | [Invocation projection](game-protocol.md#invocation-projection), [design components](design-system.md#arena-components)                                                                                                                    |

## Local setup

Use Node.js 24 and npm 11. From a clean clone:

```text
npm ci
```

Build, watch, and type-check commands use the native TypeScript 7 compiler through the `@typescript/native` npm alias, which provides `tsc`. Keep `typescript` aliased to `@typescript/typescript6` so ESLint and dependency-cruiser can use the TypeScript 6 compiler API. Retain both aliases when updating the toolchain; see the [upstream compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

Copy `.env.example` to `.env`. The committed values are local placeholders only; never place production credentials in the repository.

Start PostgreSQL and wait for its health check:

```text
npm run infra:up
```

Apply the reviewed migration history, then start the TypeScript package watchers, Fastify API, and Vite app:

```text
npm run db:migrate
npm run dev
```

The API reads the root `.env` file when present. Vite also uses the root as its environment directory but exposes only variables prefixed with `VITE_`.

## Environment contract

| Variable                    | Consumer   | Purpose                                                                   |
| --------------------------- | ---------- | ------------------------------------------------------------------------- |
| `NODE_ENV`                  | API        | `development`, `test`, or `production`                                    |
| `API_HOST`                  | API        | Fastify listen address                                                    |
| `API_PORT`                  | API        | Fastify listen port                                                       |
| `WEB_ORIGIN`                | API        | Exact browser origin allowed by CORS                                      |
| `DATABASE_URL`              | API, tools | PostgreSQL connection URL                                                 |
| `LOG_LEVEL`                 | API        | Pino log level                                                            |
| `SANDBOX_ENABLED`           | API        | Exactly `true` or `false`; defaults to false; production rejects true     |
| `GUEST_SESSION_TTL_SECONDS` | API        | Inactivity expiry, 1–31536000 seconds; defaults to 86400                  |
| `VITE_API_BASE_URL`         | web        | Public HTTP(S) API origin, without credentials, paths, query, or fragment |
| `POSTGRES_*`                | Compose    | Local database name, user, password, and port                             |
| `TEST_DATABASE_URL`         | Tests      | Explicit disposable PostgreSQL database ending in `_test`; no fallback    |
| `TEST_POSTGRES_PORT`        | Compose    | Separate test-service port, defaults to 5433                              |

Invalid environment errors contain variable names only. Never add server secrets to a `VITE_` variable.

## Root commands

| Command                      | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                | Build shared packages, watch them, and run both applications     |
| `npm run build`              | Build shared packages, the API, and the Vite production bundle   |
| `npm start`                  | Run the built API and web preview                                |
| `npm run lint`               | Run ESLint with zero warnings                                    |
| `npm run typecheck`          | Type-check project references and tests                          |
| `npm test`                   | Run unit, PostgreSQL integration, and dependency-boundary checks |
| `npm run test:unit`          | Run database-free unit tests                                     |
| `npm run test:integration`   | Run required PostgreSQL-backed tests; fail if unavailable        |
| `npm run test:e2e`           | Run desktop/mobile browser gameplay and accessibility checks     |
| `npm run format:check`       | Verify Prettier formatting                                       |
| `npm run verify`             | Run formatting, lint, types, tests, and build                    |
| `npm run smoke`              | Start and probe both built services                              |
| `npm run infra:up`           | Start and health-check PostgreSQL                                |
| `npm run infra:test:up`      | Start the isolated disposable test PostgreSQL service            |
| `npm run infra:down`         | Stop PostgreSQL while preserving data                            |
| `npm run db:generate -- ...` | Generate a named Drizzle migration                               |
| `npm run db:check`           | Check migration metadata for consistency                         |
| `npm run db:migrate`         | Apply pending migrations                                         |
| `npm run db:studio`          | Open Drizzle Studio                                              |

## Dependency direction

- `apps/web` may consume `packages/contracts` and presentation-safe exports from `packages/chess`.
- `apps/api` may consume `packages/contracts`, `packages/chess`, and `packages/database`.
- `packages/contracts` and `packages/chess` are infrastructure-independent leaves.
- `packages/database` is server-only and does not depend on application code.
- Product packages expose explicit entrypoints; consumers must not deep-import their source files.

`npm run test:architecture` validates the real graph, including external dependency edges without traversing dependency implementations. Deliberately invalid fixtures prove the web/database boundary, both independent leaves, rules-engine encapsulation, public entrypoints, the shared-package infrastructure restrictions, and exclusion of chess test helpers from production imports.

## Chess domain development

The [domain and core contract boundary](architecture.md#deterministic-domain-and-core-contracts) remains independent of HTTP and persistence. The API now consumes it through the guest command service. Import only package entrypoints. `createGame()` starts in `configuring`; call `start()` before submitting canonical UCI. Snapshot and command results contain copied data. `restoreGame({ moves, lifecycle })` replays ordered UCI moves and validates the supplied lifecycle instead of accepting a cached FEN or PGN.

Focused checks require neither PostgreSQL nor provider credentials:

```text
npm exec vitest -- run packages/chess/test packages/contracts apps/api/src/game-contracts.test.ts
npm run test:architecture
```

Special-position fixtures live in `packages/chess/test`, outside the production TypeScript root and package exports. They exercise the internal adapter through the same aggregate used by public factories. Do not export a FEN constructor, import fixtures into production, or replace the normalized repetition key with the engine's built-in hash. The regression tests cover pinned en passant, restoration between repetition cycles, and the 99-to-100 half-move boundary.

## Migrations

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. Better Auth schema generation will feed this same migration history when authentication is implemented.

Migration `0002_game_command_receipts.sql` creates the shared accepted-command receipts and backfills existing moves. Stop old API writers before applying it, then start the API version that writes receipts for every move and lifecycle action. See [ADR-0007](decisions/0007-lifecycle-recovery-and-private-replay.md). Integration tests exercise this backfill on a populated prior schema, receipt uniqueness, cascading deletion, and atomic rollback.

Migration `0003_ai_turn_persistence.sql` adds game modes, independent AI seat configuration, normalized invocation attempts, and leased turn reservations. Existing human sandbox records retain their identity, authority, history, receipts, and unfinished-game slot; their mode defaults to `human_vs_human`. Unconfigured legacy AI placeholder seats are rejected, not assigned a fabricated provider/model. The reviewed SQL creates composite unique indexes before their referencing foreign keys. Stop old writers while migrating and restart with the reservation-aware repository. Run `npm run db:check` and `npm run test:integration` to verify metadata, populated-schema upgrades, migration/write rollback, constraints, and concurrent ownership/recovery across independent pools.

The internal AI persistence operations and caller responsibilities are defined in [ADR-0009](decisions/0009-ai-turn-persistence.md) and its [stepping/retry extension](decisions/0010-ai-paused-stepping-and-retry-accounting.md). They run inside the existing game transaction interface; provider calls must run outside it. The [guest AI service](game-protocol.md#ai-game-api) composes these operations without another schema migration. Use only normalized mock outcomes in automated persistence tests, and never pass credentials or raw provider objects into repository calls.

## Logging and errors

The API logger omits request bodies, retains only method/path/request ID for requests, strips URL queries, and recursively redacts credential-like object fields. Raw exceptions are reduced to a safe name and non-secret code before serialization; the error serializer preserves only those diagnostic fields when it receives an already-sanitized record.

Idle PostgreSQL pool errors write a fixed, credential-free diagnostic to stderr without terminating the API. The pool remains available for new connections, and `/ready` checks current database availability on every request, returning `503` when its query fails.

System errors retain `code`, `message`, and `requestId`. Structured game errors use the same envelope with enumerated codes; only `GAME_CONFLICT` additionally requires an already-authorized `currentSnapshot`. Messages come from the API's English error catalog, never domain/engine exceptions. Domain failures expose codes and, for an invalid history entry, its one-based ply only. No error accepts arbitrary details or raw exception payloads. Guest/game responses are `no-store`, and the raw guest token appears only in its cookie. Corrupted persisted history or projections yield a safe `500` and leave game data unchanged. Add logging and error tests whenever a new boundary accepts credentials or provider payloads.
