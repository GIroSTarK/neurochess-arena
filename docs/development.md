# Development guide

## Local setup

Use Node.js 24 and npm 11. From a clean clone:

```text
npm ci
```

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

| Variable            | Consumer   | Purpose                                       |
| ------------------- | ---------- | --------------------------------------------- |
| `NODE_ENV`          | API        | `development`, `test`, or `production`        |
| `API_HOST`          | API        | Fastify listen address                        |
| `API_PORT`          | API        | Fastify listen port                           |
| `WEB_ORIGIN`        | API        | Exact browser origin allowed by CORS          |
| `DATABASE_URL`      | API, tools | PostgreSQL connection URL                     |
| `LOG_LEVEL`         | API        | Pino log level                                |
| `VITE_API_BASE_URL` | web        | Public API origin compiled into the web app   |
| `POSTGRES_*`        | Compose    | Local database name, user, password, and port |

Invalid environment errors contain variable names only. Never add server secrets to a `VITE_` variable.

## Root commands

| Command                      | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `npm run dev`                | Build shared packages, watch them, and run both applications   |
| `npm run build`              | Build shared packages, the API, and the Vite production bundle |
| `npm start`                  | Run the built API and web preview                              |
| `npm run lint`               | Run ESLint with zero warnings                                  |
| `npm run typecheck`          | Type-check project references and tests                        |
| `npm test`                   | Run Vitest and dependency-boundary checks                      |
| `npm run format:check`       | Verify Prettier formatting                                     |
| `npm run verify`             | Run formatting, lint, types, tests, and build                  |
| `npm run smoke`              | Start and probe both built services                            |
| `npm run infra:up`           | Start and health-check PostgreSQL                              |
| `npm run infra:down`         | Stop PostgreSQL while preserving data                          |
| `npm run db:generate -- ...` | Generate a named Drizzle migration                             |
| `npm run db:check`           | Check migration metadata for consistency                       |
| `npm run db:migrate`         | Apply pending migrations                                       |
| `npm run db:studio`          | Open Drizzle Studio                                            |

## Dependency direction

- `apps/web` may consume `packages/contracts` and presentation-safe exports from `packages/chess`.
- `apps/api` may consume `packages/contracts`, `packages/chess`, and `packages/database`.
- `packages/contracts` and `packages/chess` are infrastructure-independent leaves.
- `packages/database` is server-only and does not depend on application code.
- Product packages expose explicit entrypoints; consumers must not deep-import their source files.

`npm run test:architecture` validates the real graph, including external dependency edges without traversing dependency implementations. Deliberately invalid fixtures prove the web/database boundary, both independent leaves, rules-engine encapsulation, public entrypoints, the shared-package infrastructure restrictions, and exclusion of chess test helpers from production imports.

## Chess domain development

The [domain and core contract boundary](architecture.md#deterministic-domain-and-core-contracts) is implemented without game routes or database tables. Import only package entrypoints. `createGame()` starts in `configuring`; call `start()` before submitting canonical UCI. Snapshot and command results contain copied data. `restoreGame({ moves, lifecycle })` replays ordered UCI moves and validates the supplied lifecycle instead of accepting a cached FEN or PGN.

Focused checks require neither PostgreSQL nor provider credentials:

```text
npm exec vitest -- run packages/chess/test packages/contracts apps/api/src/game-contracts.test.ts
npm run test:architecture
```

Special-position fixtures live in `packages/chess/test`, outside the production TypeScript root and package exports. They exercise the internal adapter through the same aggregate used by public factories. Do not export a FEN constructor, import fixtures into production, or replace the normalized repetition key with the engine's built-in hash. The regression tests cover pinned en passant, restoration between repetition cycles, and the 99-to-100 half-move boundary.

## Migrations

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. Better Auth schema generation will feed this same migration history when authentication is implemented.

## Logging and errors

The API logger omits request bodies, retains only method/path/request ID for requests, strips URL queries, and recursively redacts credential-like object fields. Raw exceptions are reduced to a safe name and non-secret code before serialization; the error serializer preserves only those diagnostic fields when it receives an already-sanitized record.

Idle PostgreSQL pool errors write a fixed, credential-free diagnostic to stderr without terminating the API. The pool remains available for new connections, and `/ready` checks current database availability on every request, returning `503` when its query fails.

System errors retain `code`, `message`, and `requestId`. Structured game errors use the same envelope with enumerated codes; only `GAME_CONFLICT` additionally requires `currentSnapshot`, which a future command handler must authorize before returning. Messages are safe application-supplied display text, never domain/engine exceptions. Domain failures expose codes and, for an invalid history entry, its one-based ply only. No error accepts arbitrary details or raw exception payloads. Add logging and error tests whenever a new boundary accepts credentials or provider payloads.
