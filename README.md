# Neurochess Arena

Neurochess Arena is a web application for watching and comparing large language models while they play chess. AI versus AI is the flagship experience, supported by AI versus human and private online human versus human games.

> Status: Phase 1 in progress. The localized development sandbox now lets one guest play both colors through the server-authoritative API and PostgreSQL. It includes an accessible board, explicit promotion, SAN history, and command recovery. Paused refresh recovery, lifecycle controls, and replay/export endpoints remain pending; AI and online rooms arrive in later phases.

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

The sandbox is disabled by default. Set `SANDBOX_ENABLED=true` in your local `.env`, restart the API, and select **Start sandbox** in the web app. The guest controls both colors. Reload returns to the entry screen; starting again reopens an unfinished game with its stored lifecycle. See the [sandbox walkthrough](docs/development.md#sandbox-ui). Production cannot enable it.

## Verification

`npm test` includes real PostgreSQL integration tests. Ensure `.env` contains the explicit `TEST_DATABASE_URL` from `.env.example`, then run the complete local baseline:

```text
npm run infra:test:up
npm run verify
npm exec playwright -- install chromium
npm run test:e2e
```

The repository also exposes the required checks individually:

```text
npm run lint
npm run typecheck
npm test
npm run build
```

After a successful build, `npm start` runs the compiled API and the Vite production preview. With PostgreSQL running, `npm run smoke` checks both built services.

Use `npm run test:unit` for database-free checks. The separate test service uses disposable storage on port 5433; it does not share the development database volume.

The [browser suite](docs/development.md#browser-tests) starts isolated Fastify/Vite services on localhost ports 3101/5174. It covers desktop and mobile touch gameplay, promotion, keyboard navigation, responsive layouts, and automated accessibility. Browser traces are disabled to avoid recording guest cookie headers.

## Database workflow

Drizzle schema source and migrations live in `packages/database`. Use:

```text
npm run db:generate -- --name <migration-name>
npm run db:check
npm run db:migrate
npm run db:studio
```

Review generated SQL before applying or committing it. Do not use `drizzle-kit push`, and never edit an already-applied migration; add a forward migration instead.

The no-op Phase 0 bootstrap migration is retained. The next migration adds guest sessions, games, participants, and moves. Better Auth tables remain deferred to the authentication phase.

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
- [Design system](docs/design-system.md) and [screen concepts](docs/design-system/concepts/README.md)
- [Architecture](docs/architecture.md)
- [MVP roadmap](docs/roadmap.md)
- [Development guide](docs/development.md)
- [Architecture decisions](docs/decisions/README.md)
- [Instructions for coding agents](AGENTS.md)

## License

No license has been selected yet.
