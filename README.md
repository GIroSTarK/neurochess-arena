# Neurochess Arena

Neurochess Arena is a web application for watching and comparing large language models while they play chess. AI versus AI is the flagship experience, supported by AI versus human and private online human versus human games.

> Status: Phase 0 repository foundation. The empty React application, Fastify API, PostgreSQL connection, migrations, tests, builds, and CI are operational. Product gameplay begins in Phase 1.

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

## Verification

Run the complete local baseline with:

```text
npm run verify
```

The repository also exposes the required checks individually:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

After a successful build, `npm start` runs the compiled API and the Vite production preview. With PostgreSQL running, `npm run smoke` checks both built services.

## Database workflow

Drizzle schema source and migrations live in `packages/database`. Use:

```text
npm run db:generate -- --name <migration-name>
npm run db:check
npm run db:migrate
npm run db:studio
```

Review generated SQL before applying or committing it. Do not use `drizzle-kit push`, and never edit an already-applied migration; add a forward migration instead.

Phase 0 contains only a no-op bootstrap migration. Domain and Better Auth tables are intentionally deferred to the phases that implement them.

## Workspace boundaries

```text
apps/web           React, Vite, browser state
apps/api           Fastify, HTTP and later WebSocket orchestration
packages/chess     Deterministic chess domain (implemented in Phase 1)
packages/contracts Runtime-validated transport contracts
packages/database  Drizzle, PostgreSQL, repositories, and migrations
packages/config    Shared TypeScript, lint, format, and test configuration
```

Automated architecture checks keep the browser out of API and database code, prevent shared packages from importing applications, reject cycles, and require consumers to use package public entrypoints.

## Security model

Environment files are ignored by Git. API startup validates configuration without printing values, request logging strips URL queries and redacts credential-like fields, and errors use a safe public response contract.

Raw provider keys must never be committed, logged, included in analytics, or stored in browser persistence. See [ADR-0004](docs/decisions/0004-bring-your-own-key-security.md) for the complete future credential lifecycle.

## Project documentation

- [Product specification](docs/product.md)
- [Architecture](docs/architecture.md)
- [MVP roadmap](docs/roadmap.md)
- [Development guide](docs/development.md)
- [Architecture decisions](docs/decisions/README.md)
- [Instructions for coding agents](AGENTS.md)

## License

No license has been selected yet.
