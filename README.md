# Neurochess Arena

Neurochess Arena is a web application for watching and comparing large language models while they play chess. Its primary experience is AI versus AI, supported by AI versus human and private online human versus human games.

> Status: documentation and architecture planning. The application has not been bootstrapped yet.

## MVP

- Configure a provider, model, and supported model parameters independently for White and Black.
- Play AI versus AI, AI versus human, and private online human versus human games.
- Support OpenAI, Anthropic, Google, and OpenRouter through user-provided API keys.
- Validate every move with a deterministic chess rules engine.
- Show live model commentary, move history, Stockfish evaluation, latency, token usage, and estimated cost.
- Pause, resume, and step through AI games.
- Provide accounts, private game history, replay, analysis, and PGN export.
- Allow guests to use AI modes and join invitation-only human games.
- Deliver a dark, futuristic, responsive interface in English, with localization-ready code.

Ratings, tournaments, chat, social features, and payments are explicitly outside the MVP.

## Technical direction

| Area              | Choice                            |
| ----------------- | --------------------------------- |
| Web               | React, TypeScript, Vite           |
| API               | Fastify, TypeScript               |
| Database          | PostgreSQL                        |
| Database access   | Drizzle ORM, stable release line  |
| Authentication    | Better Auth                       |
| Realtime          | WebSocket                         |
| Chess analysis    | Stockfish in a browser Web Worker |
| Local development | Docker Compose                    |

The intended repository layout is an npm workspaces monorepo:

```text
apps/
  web/          React application
  api/          Fastify application
packages/
  chess/        Chess-domain rules and shared types
  contracts/    Runtime-validated HTTP and WebSocket contracts
  database/     Drizzle schema, migrations, and database access
  config/       Shared development configuration
```

## Project documentation

- [Product specification](docs/product.md)
- [Architecture](docs/architecture.md)
- [MVP roadmap](docs/roadmap.md)
- [Architecture decisions](docs/decisions/README.md)
- [Instructions for coding agents](AGENTS.md)

These are living documents. A behavior or architectural change is not complete until the relevant document is updated.

## Security model

Neurochess Arena uses bring-your-own-key access to AI providers. Raw provider keys must never be committed, logged, included in analytics, or stored in browser persistence. Session-only keys remain in memory. A registered user may explicitly opt into encrypted server-side storage.

See [ADR-0004](docs/decisions/0004-bring-your-own-key-security.md) for the full decision.

## Development

Setup and verification commands will be added when the workspace is bootstrapped. The planned baseline commands are `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.

## License

No license has been selected yet.
