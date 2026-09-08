# Neurochess Arena

Neurochess Arena is a web application for watching and comparing large language models while they play chess. AI versus AI is the flagship experience, supported by AI versus human and private online human versus human games.

Implementation status and next milestones live in the [MVP roadmap](docs/roadmap.md).

## Prerequisites

- Node.js 24
- npm 11
- Docker with Docker Compose

The repository is an npm workspaces monorepo. Dependency versions are locked in `package-lock.json` and the database runs locally through Docker Compose.

## Quick start

Install dependencies and create a local environment file:

```powershell
npm ci
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead of `Copy-Item`.

Start PostgreSQL, apply migrations, and run both applications:

```text
npm run infra:up
npm run db:migrate
npm run dev
```

The development services are available at:

- web: `http://localhost:5173`
- API liveness: `http://localhost:3001/health`
- API readiness: `http://localhost:3001/ready`

`npm run infra:down` stops PostgreSQL but preserves its named data volume.

The development sandbox is disabled by default. Set `SANDBOX_ENABLED=true` in your local `.env` and restart the API. See the [sandbox walkthrough](docs/gameplay.md#sandbox-ui) for play, paused recovery, lifecycle controls, and private replay/export. Production cannot enable it.

## Verification

Every change must pass `npm run verify`, including formatting, lint, types, unit/integration/architecture tests, and build. Ensure `.env` contains the explicit disposable `TEST_DATABASE_URL` from `.env.example`:

```text
npm run infra:test:up
npm run verify
```

For browser/game-flow changes and milestone acceptance, also run the complete browser suite:

```text
npm exec playwright -- install chromium
npm run test:e2e
```

The [verification guide](docs/testing.md#required-checks) is the canonical checklist, including migration and built-service checks. After a successful build, `npm start` runs the compiled API and the Vite production preview; `npm run smoke` checks both built services with PostgreSQL available.

Use `npm run test:unit` for database-free checks. The separate test service uses disposable storage on port 5433; it does not share the development database volume.

The [browser suite](docs/testing.md#browser-tests) starts isolated Fastify/Vite services on localhost ports 3101/5174. It covers desktop and mobile touch gameplay, promotion, keyboard navigation, responsive layouts, and automated accessibility. Browser traces are disabled to avoid recording guest cookie headers.

## Database workflow

Drizzle schema source and migrations live in `packages/database`. Use:

```text
npm run db:generate -- --name <migration-name>
npm run db:check
npm run db:migrate
npm run db:studio
```

Review generated SQL before applying or committing it. Do not use `drizzle-kit push`, and never edit an already-applied migration; add a forward migration instead.

See the [migration guide](docs/development.md#migrations) for upgrade ordering and compatibility requirements.

## Workspace boundaries

```text
apps/web           React, Vite, Tailwind CSS, browser state
apps/api           Fastify, server-side orchestration
packages/chess     Deterministic chess domain
packages/contracts Runtime-validated transport contracts
packages/database  Drizzle, PostgreSQL, repositories, and migrations
packages/config    Shared TypeScript, lint, format, and test configuration
```

Automated architecture checks keep the browser out of API and database code, prevent shared packages from importing applications, reject cycles, and require consumers to use package public entrypoints.

## Security model

Environment files are ignored by Git. API startup validates configuration without printing values, request logging strips URL queries and redacts credential-like fields, and errors use a safe public response contract.

Raw provider keys must never be committed, logged, included in analytics, or stored in browser persistence. See [ADR-0004](docs/decisions/0004-bring-your-own-key-security.md) for the credential policy.

## Project documentation

- [Product specification](docs/product.md)
- [Design system](docs/design-system.md) and [screen concepts](docs/design-system/concepts/README.md)
- [Architecture](docs/architecture.md)
- [MVP roadmap](docs/roadmap.md)
- [Development guide and task navigation](docs/development.md)
- [Game protocol](docs/game-protocol.md) and [gameplay walkthroughs](docs/gameplay.md)
- [Provider reference](docs/providers.md)
- [Verification guide](docs/testing.md)
- [Architecture decisions](docs/decisions/README.md)
- [Instructions for coding agents](AGENTS.md)

## License

No license has been selected yet.
