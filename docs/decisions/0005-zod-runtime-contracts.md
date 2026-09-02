# ADR-0005: Zod 4 for runtime contracts

**Status:** Accepted  
**Date:** 2026-09-01

## Context

The API, web app, environment loader, WebSocket protocol, and future provider adapters all accept data that TypeScript cannot validate at runtime. Shared transport contracts must remain independent of Fastify implementation code while still supporting inferred TypeScript types and schema-driven route serialization.

## Decision

- Use Zod 4 for runtime validation at environment, HTTP, WebSocket, and provider boundaries.
- Keep shared transport schemas and their inferred types in `packages/contracts`.
- Keep application-specific environment schemas in the application that owns the variables.
- Integrate shared schemas with Fastify through `fastify-type-provider-zod` without importing Fastify into shared packages.
- Return explicit serialized response shapes rather than raw domain objects or exceptions.

## Consequences

- Runtime schemas and TypeScript types share one definition.
- Browser and server code can validate the same transport payload without sharing implementation modules.
- Fastify integration and future OpenAPI generation require a maintained Zod-to-JSON-Schema adapter.
- Provider-specific normalization may use internal Zod schemas, but only stable normalized contracts cross package boundaries.

## Alternatives considered

### TypeBox

TypeBox integrates directly with Fastify JSON Schema, but environment and non-HTTP validation would use a less uniform API for this project.

### Valibot

Valibot offers a small modular runtime, but would require more custom Fastify and OpenAPI integration for no material Phase 0 advantage.
