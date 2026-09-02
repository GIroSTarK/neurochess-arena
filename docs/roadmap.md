# MVP roadmap

**Status:** Phase 0 completed; remaining phases planned

**Last updated:** 2026-09-02

The MVP contains all three game modes. The phases below are implementation checkpoints, not separate product editions.

## Phase 0 — Repository foundation

**Status:** Completed

Deliverables:

- [x] initialize Git and the npm workspaces monorepo;
- [x] create `apps/web`, `apps/api`, and shared packages;
- [x] configure TypeScript, linting, formatting, tests, and CI;
- [x] add Docker Compose with PostgreSQL;
- [x] configure environment validation and secret-safe logging;
- [x] establish Drizzle schema and migration workflow;
- [x] add basic architecture tests that prevent forbidden package imports.

Exit condition: a clean clone can install, start, test, and build the empty web/API system using documented commands.

## Phase 1 — Chess vertical slice

Build the human-command path first. A [local development sandbox](architecture.md#local-development-sandbox) lets one guest session play both colors through the real API, database, and chess rules.

Deliverables:

- dark responsive application shell and chessboard;
- standard initial position and complete legal move handling;
- server-authoritative game creation and human move command;
- guest-session identity, private ownership checks, and concurrency-safe enforcement of one `active` or `paused` game per session;
- recovery of an unfinished sandbox game as `paused`, with explicit resume;
- game lifecycle, FEN/PGN persistence, result detection, replay, and PGN export;
- unit tests for standard chess outcomes and the [automatic draw policy](product.md#automatic-draw-policy);
- localization layer with English strings.

Exit condition: one guest in the development sandbox can complete and replay a deterministic chess game from one browser without AI or realtime rooms, passing the [Phase 1 verification checks](architecture.md#verification-strategy).

## Phase 2 — AI arena core

Deliverables:

- mocked AI integration tests through the existing authoritative command service, followed by real provider adapters;
- common provider adapter and runtime-validated move contract;
- OpenAI, Anthropic, Google, and OpenRouter adapters;
- live model discovery and capability-aware parameters;
- session-only credential path with strict redaction, key loss on refresh/close, and key re-entry before resuming a recovered game;
- independent White and Black configuration;
- AI-versus-AI orchestration, pause, resume, next move, speed, and stop;
- AI-versus-human mode with color choice;
- invalid-output retries, technical loss, provider-error pause, and manual retry;
- latency and token telemetry.

Exit condition: guests can complete both AI modes with any supported provider combination, and no model can bypass server-side move validation.

## Phase 3 — Accounts, encrypted credentials, and history

Deliverables:

- Better Auth with email/password, Google, and GitHub;
- email verification and password reset;
- unique usernames and avatars;
- encrypted opt-in provider credential storage;
- extend guest-session ownership, single-game limits, and paused recovery to authenticated accounts;
- durable private game history and result pages;
- individual game deletion, history clearing, credential revocation, and account deletion;
- authenticated recovery using re-entered session-only keys or explicitly saved encrypted credentials.

Exit condition: registered and guest lifecycle rules match the product specification, including deletion and credential-security tests.

## Phase 4 — Private online human games

Deliverables:

- authenticated room creation and owner color choice;
- unguessable invitation link/code;
- registered or guest join flow;
- authenticated WebSocket snapshot and event protocol;
- server-authoritative turn broadcasts;
- disconnect and indefinite reconnect behavior;
- owner-controlled abort with `aborted` history state;
- authorization and privacy tests.

Exit condition: two separate browser sessions can complete or abort a private game and recover correctly from disconnections.

## Phase 5 — Analysis, polish, and release hardening

Deliverables:

- Stockfish Web Worker analysis after every move;
- live and post-game evaluation graph;
- commentary, attempt, latency, token, and estimated-cost views;
- explicit unavailable states for incomplete pricing or usage data;
- desktop and mobile UX refinement;
- keyboard navigation, contrast, focus, and reduced-motion review;
- cross-browser end-to-end suite;
- rate limiting, security headers, dependency audit, backup and restore check;
- deployment selection, production configuration, monitoring, and release checklist.

Exit condition: every MVP acceptance criterion in `docs/product.md` is verified and no release-blocking defect remains.

## Recommended first implementation slice

After Phase 0, build one narrow end-to-end path before expanding the UI:

```text
create a standard game owned by a guest session
  -> submit one human UCI move
  -> authorize and validate on the server
  -> atomically persist the move, FEN/PGN, and game version
  -> render the accepted position and move list
```

Extend this path to a complete game, lifecycle controls, replay, and PGN copy/download. It proves legal moves, persistence, command concurrency, and board interaction before Phase 2 adds provider behavior through the same command service. Provider requests, commentary, and telemetry are not Phase 1 dependencies.

## Post-MVP candidates

- chess clocks and provider-response time limits;
- additional locales;
- arbitrary FEN starting positions;
- public spectator links;
- background AI games;
- multiple concurrent games;
- custom model prompts;
- additional AI providers;
- horizontal realtime scaling with shared pub/sub.

Ratings, tournaments, chat, social features, and payments require separate product decisions and are not assumed to be planned.
