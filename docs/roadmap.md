# MVP roadmap

**Status:** Phases 0 and 1 and the Sandbox presentation remake completed; Phase 2 in progress

**Last updated:** 2026-09-19

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

## Sandbox presentation remake — before Phase 2

**Status:** Completed

Use the [selected Sandbox concepts](design-system/concepts/sandbox-v1/README.md) to establish the shared presentation foundation for the three public modes.

- [x] select coordinated entry, live, recovery, and replay concepts for desktop and mobile;
- [x] extract the shared shell, arena layout, participant and game panels behind Sandbox adapters, with an enforced presentation boundary;
- [x] apply the live composition and board-toolbar action hierarchy;
- [x] apply the entry, recovery, and result/replay compositions;
- [x] separate the Arena placeholder from flag-gated Sandbox navigation;
- [x] exercise the shared presentation with explicit human/AI reference scenarios and future panel slots;
- [x] complete concept-to-browser comparison and responsive, keyboard, recovery, and replay acceptance.

Exit condition: Sandbox uses the selected arena design, and the same presentation components can serve the upcoming modes through their own data and actions.

## Phase 2 — AI arena core

Implementation sequence: [Phase 2 PR plan](phase-2-plan.md).

Completed milestones: P2-01 establishes strict AI configuration/provider contracts, relational seat persistence, and private service creation/restoration. P2-02 adds authoritative execution with injected adapters, database-backed reservations, accepted-command deduplication, and explicit crash recovery. P2-03 adds durable logical-turn retry budgets, automatic invalid-output retries and technical losses, provider-error pauses, and private normalized invocation records linked to accepted moves. P2-04 adds protected discovery/create/turn/read routes, uncached request-scoped discovery, capability filtering, operational cancellation/deadlines, and a page-memory credential/client boundary. PostgreSQL tests cover concurrent instances, late outcomes, authorization, atomic rollback, killed executors, recovery without budget resets, natural match outcomes, HTTP disconnects, and credential redaction. Sandbox behavior and the shared unfinished-game slot are preserved. No live provider or public AI controller is enabled. P2-05 follows with the OpenAI adapter, registered explicitly through the existing provider interface and verified against mocked upstream transport.

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
