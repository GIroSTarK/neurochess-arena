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

`npm run test:architecture` validates the real graph and also proves the web-to-database rule against a deliberately invalid fixture.

## Migrations

Schema definitions live under `packages/database/src/schema`. Generate SQL with Drizzle Kit, inspect the generated SQL and metadata, and commit both. Apply migrations explicitly; the API does not mutate the schema during startup.

Never edit an applied migration or use schema push as a substitute for reviewed SQL. Better Auth schema generation will feed this same migration history when authentication is implemented.

## Logging and errors

The API logger omits request bodies, retains only method/path/request ID for requests, strips URL queries, and recursively redacts credential-like object fields. Raw exceptions are reduced to a safe name and non-secret code before serialization; the error serializer preserves only those diagnostic fields when it receives an already-sanitized record.

Idle PostgreSQL pool errors write a fixed, credential-free diagnostic to stderr without terminating the API. The pool remains available for new connections, and `/ready` checks current database availability on every request, returning `503` when its query fails.

Public errors contain only `code`, `message`, and `requestId`. Add logging and error tests whenever a new boundary accepts credentials or provider payloads.
