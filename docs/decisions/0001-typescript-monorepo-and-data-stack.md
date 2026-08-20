# ADR-0001: TypeScript monorepo and data stack

**Status:** Accepted  
**Date:** 2026-08-15

## Context

Neurochess Arena needs a browser application, an HTTP/WebSocket backend, shared runtime contracts, relational persistence, authentication, and portable deployment. The team intends to build the frontend with React, TypeScript, and Vite, and the backend with Fastify and TypeScript.

The database layer must represent strongly related entities such as users, accounts, rooms, games, participants, moves, and model invocations while still accommodating bounded provider-specific metadata.

## Decision

- Use npm workspaces with `apps/web`, `apps/api`, and focused shared packages.
- Use React, TypeScript, and Vite for the web application.
- Use Fastify and TypeScript for the API and WebSocket server.
- Use PostgreSQL as the durable system of record.
- Use Drizzle ORM and Drizzle Kit for typed schema definitions, queries, and reviewed SQL migrations.
- Use the current stable Drizzle release line. Do not adopt beta or release-candidate relations APIs without a separate decision.
- Use Better Auth with its Drizzle adapter for email/password, Google, GitHub, verification, reset, and session persistence.
- Use normalized columns and relations for core domain data; use `jsonb` only for bounded provider-specific configuration or metadata.
- Keep local development containerized with Docker Compose while leaving production hosting open.

## Consequences

- TypeScript types and runtime contracts can be shared without sharing server implementation code.
- Drizzle keeps database definitions close to SQL and permits explicit PostgreSQL usage without maintaining a separate Prisma schema language.
- Developers must review generated SQL and may write more explicit joins or queries than with a higher-level ORM.
- Better Auth schema generation must feed the Drizzle migration workflow; Better Auth must not apply an independent competing schema history.
- A long-running Fastify/WebSocket process narrows the production hosting choices compared with a purely static or request-only serverless application.

## Alternatives considered

### Prisma ORM

Prisma offers a mature generated client, declarative relations, migrations, and excellent developer tooling. It is a valid alternative, but the project prefers Drizzle's TypeScript-first schema, SQL transparency, smaller abstraction boundary, and direct fit with the chosen TypeScript/Fastify stack. Prisma does not provide enough project-specific advantage to justify its additional schema and generated-client layer.

### Document database

Rejected because users, seats, games, moves, rooms, credentials, and deletion rules are fundamentally relational and benefit from constraints and transactions.

### Redis in the initial stack

Deferred. PostgreSQL stores canonical state and one Fastify instance owns active sockets for the MVP. Redis or another pub/sub layer will require a new ADR when horizontal scaling is necessary.
