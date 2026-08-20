# MVP roadmap

**Status:** Proposed delivery sequence  
**Last updated:** 2026-09-01

The MVP contains all three game modes. The phases below are implementation checkpoints, not separate product editions.

## Phase 0 — Repository foundation

Deliverables:

- initialize Git and the npm workspaces monorepo;
- create `apps/web`, `apps/api`, and shared packages;
- configure TypeScript, linting, formatting, tests, and CI;
- add Docker Compose with PostgreSQL;
- configure environment validation and secret-safe logging;
- establish Drizzle schema and migration workflow;
- add basic architecture tests that prevent forbidden package imports.

Exit condition: a clean clone can install, start, test, and build the empty web/API system using documented commands.

## Phase 1 — Chess vertical slice

Deliverables:

- dark responsive application shell and chessboard;
- standard initial position and complete legal move handling;
- server-authoritative game creation and human move command;
- game lifecycle, FEN/PGN persistence, result detection, replay, and PGN export;
- unit tests for standard chess outcomes;
- localization layer with English strings.

Exit condition: one browser can complete and replay a deterministic chess game without AI or realtime rooms.

## Phase 2 — AI arena core

Deliverables:

- common provider adapter and runtime-validated move contract;
- OpenAI, Anthropic, Google, and OpenRouter adapters;
- live model discovery and capability-aware parameters;
- session-only credential path with strict redaction;
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
- enforcement of at most one game in the `active` or `paused` state per authenticated user or guest session;
- private game history and result pages;
- individual game deletion, history clearing, credential revocation, and account deletion;
- guest refresh recovery with a paused game and mandatory key re-entry.

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
create standard game
  -> request one mocked AI move
  -> validate against legal moves
  -> persist move and new FEN/PGN
  -> render updated board and commentary
```

This slice exercises the most important boundary—LLM suggestion versus deterministic chess authority—without requiring authentication, multiple providers, or realtime rooms.

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
