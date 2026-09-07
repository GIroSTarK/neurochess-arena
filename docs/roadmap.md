# MVP roadmap

**Status:** Phases 0 and 1 completed; Phase 2 in progress

**Last updated:** 2026-09-07

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

**Status:** Completed. See the [sandbox walkthrough](development.md#sandbox-ui) for usage and [verification strategy](architecture.md#verification-strategy) for acceptance criteria. Remaining cross-browser, assistive-technology, and performance work is tracked in the [validation limits](design-system/validation.md) and Phase 5 below.

Build the human-command path first. A [local development sandbox](architecture.md#local-development-sandbox) lets one guest session play both colors through the real API, database, and chess rules.

Deliverables:

- [x] dark responsive application shell and accessible keyboard/touch chessboard, explicit promotion, and read-only SAN history;
- [x] standard initial position and complete legal move handling;
- [x] server-authoritative sandbox creation and human move command;
- [x] guest-cookie bootstrap, private ownership checks, and concurrency-safe enforcement of one `active` or `paused` owned game per guest session;
- [x] atomic move/FEN/PGN/version persistence, natural result detection, and full-history database restoration;
- [x] PostgreSQL integration tests for ownership, concurrency, rollback, migration constraints, and restoration;
- [x] recovery of an unfinished sandbox game as `paused`, with explicit resume and complete draw history;
- [x] pause, resume, abort, and human-resignation commands with shared accepted-command receipts;
- [x] private terminal replay and PGN copy/download, with guest-session access to previous game URLs;
- [x] unit tests for standard chess outcomes and the [automatic draw policy](product.md#automatic-draw-policy);
- [x] typed UI localization layer with bundled English strings, fallback, safe API-code mapping, and localized announcements;
- [x] client command/recovery tests and desktop/mobile Playwright gameplay and accessibility checks against the disposable PostgreSQL database.

Exit condition: one guest in the development sandbox can complete and replay a deterministic chess game from one browser without AI or realtime rooms, passing the [Phase 1 verification checks](architecture.md#verification-strategy).

## Phase 2 — AI arena core

Deliverables:

- [x] shared AI runtime schemas, common server-side provider interface, authoritative model context, and scripted mock adapter with provider contract tests;
- [x] AI game modes, independent seat configuration, normalized invocation attempts, and durable leased turn reservations with PostgreSQL migration, rollback, constraint, and concurrency tests;
- [x] guest AI creation/discovery and one authoritative AI turn through the existing command service, with mocked PostgreSQL integration tests for both modes, duplicate execution prevention, lifecycle invalidation, and atomic commit;
- [x] AI retry accounting across manual retries and interruptions, technical losses, provider-error pause, and API pause/resume/stop/paused stepping with mocked completion-race tests;
- [x] guest-protected backend model discovery through the provider registry, bounded credential-free capability catalogs, server-side parameter filtering, and request-only AI-turn keys with mocked isolation, redaction, cancellation, and persistence tests;
- [x] OpenAI live model discovery and Responses move adapter with conservative capability metadata, normalized output/errors/telemetry, mocked shared contract and API integration tests;
- [x] Anthropic paginated discovery and Messages adapter with live capability mapping, normalized content/errors/usage, and mocked shared contract and mixed-provider game integration tests;
- [x] Google paginated model discovery and GenerateContent adapter with model eligibility, conservative capability mapping, normalized output/errors/usage, and mocked shared contract and game-service integration tests;
- [x] OpenRouter live discovery and Chat Completions adapter preserving model IDs and variants, with routed capability/output/error/usage normalization and mocked shared contract and game-service integration tests;
- [x] localized AI setup with live model discovery, searchable model selection, capability-aware parameter controls, and loading/failure/empty/unsupported states;
- [x] independent White and Black configuration, including identical-provider/model matches, and AI-versus-human setup with either human color;
- [x] separate page-memory setup credentials, masked/reveal controls, key loss on refresh/close, credential-free creation, and component/desktop/mobile browser coverage of validation and storage isolation;
- [x] setup handoff to an authoritative read-only board, existing-game return, paused recovery, and confirmed stop through the shared command session;
- [ ] key re-entry before resuming a recovered AI game;
- [x] AI-versus-AI orchestration, pause/resume, single paused stepping, presentation speed, and Stop during thinking, with uncertain-response reconciliation and controller/desktop/mobile mock-provider coverage;
- [ ] AI-versus-human gameplay using the configured human color;
- [ ] browser controls and feedback for invalid-output retries, technical loss, provider-error pause, and manual retry;
- [ ] latency and token telemetry collection and display.

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
