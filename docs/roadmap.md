# MVP roadmap

**Status:** Phases 0–2 and the Sandbox presentation remake completed; Phase 3 in progress

**Last updated:** 2026-10-01

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

**Status:** Completed

Completed milestones: P2-01 establishes strict AI configuration/provider contracts, relational seat persistence, and private service creation/restoration. P2-02 adds authoritative execution with injected adapters, database-backed reservations, accepted-command deduplication, and explicit crash recovery. P2-03 adds durable logical-turn retry budgets, automatic invalid-output retries and technical losses, provider-error pauses, and private normalized invocation records linked to accepted moves. P2-04 adds protected discovery/create/turn/read routes, uncached request-scoped discovery, capability filtering, operational cancellation/deadlines, and a page-memory credential/client boundary. P2-05 registers the OpenAI adapter with dynamic model discovery, conservative capabilities, Responses API normalization, and a reusable HTTP adapter contract suite. P2-06 registers Anthropic with paginated discovery, advertised output/effort capabilities, persisted required output defaults, and Messages normalization through the same contract suite. P2-07 registers Google with paginated discovery, advertised generation methods and parameter bounds, candidate/usage normalization, and the same contract suite. P2-08 registers OpenRouter with account-filtered discovery, routed identifiers, advertised parameters and reasoning efforts, explicit fallback/compression controls, and router/upstream error and usage normalization through the same suite. PostgreSQL tests cover concurrent instances, late outcomes, authorization, atomic rollback, killed executors, recovery without budget resets, natural match outcomes, HTTP disconnects, credential redaction, and OpenAI/Anthropic/Google/OpenRouter turns through mocked upstream transport. Sandbox behavior and the independent unfinished-game limits are preserved. P2-09 adds independent White/Black setup, searchable dynamic model catalogs, capability-derived parameters, session-only secret fields, stale-response cancellation, and a credential-free creation/return handoff. Component/API and isolated desktop/mobile browser tests exercise setup through the real API with injected discovery fixtures. P2-10 connects setup and AI-versus-AI observation at `/` with serialized turns, Pause/Resume, atomic paused Next move, speed, confirmed Stop, private replay/PGN, and explicit paused recovery at authorized game URLs. Database-backed controller leases fence expired/competing tabs and late provider outcomes; the presence worker pauses abandoned games, including between calls and after restart. Keys remain page-owned and recovery requires missing keys plus explicit continuation. P2-11 adds AI-versus-human setup with either human color, AI-first opening, one AI reply per accepted human move, the shared keyboard/touch board and promotion dialog, and confirmed human-only resignation. It reuses versioned human commands, explicit uncertain-command retry, paused recovery, controller presence, and private replay while requiring only the key for the AI seat. API and desktop/mobile browser coverage exercise seat authority with Sandbox enabled/disabled, duplicate commands, natural completion, promotion, provider retry, and key loss. P2-12 fills Commentary, telemetry, and Events with normalized invocation records, links accepted-move details to replay, and distinguishes missing measurements from reported zero in totals that include every attempt. The ordered 4-by-4 provider matrix and all four providers against both human colors complete natural games through the real adapters, API, and PostgreSQL with deterministic upstream fixtures. Private completed/aborted replay and canonical PGN remain accessible after another game starts, while other guests are denied. Desktop/mobile acceptance covers retry history, technical loss, provider pause/manual retry, missing usage, key loss, controller absence, and Sandbox regressions.

Deliverables:

- [x] mocked AI integration tests through the existing authoritative command service, followed by real provider adapters;
- [x] common provider adapter and runtime-validated move contract;
- [x] OpenAI, Anthropic, Google, and OpenRouter adapters;
- [x] live model discovery and capability-aware parameters;
- [x] session-only credential path with strict redaction, key loss on refresh/close, and key re-entry before resuming a recovered game;
- [x] independent White and Black configuration;
- [x] AI-versus-AI orchestration, pause, resume, next move, speed, and stop;
- [x] AI-versus-human mode with color choice;
- [x] invalid-output retries, technical loss, provider-error pause, and manual retry;
- [x] latency and token telemetry.

Exit condition: guests can complete both AI modes with any supported provider combination, and no model can bypass server-side move validation.

## Phase 3 — Accounts, encrypted credentials, and history

**Status:** In progress

Completed milestones: P3-01 introduces the server-derived principal and identity validity/locking boundary while preserving guest authorization, expiry, controller cleanup, and independent Sandbox limits. The [accepted identity ADR](decisions/0013-server-derived-principals-and-account-lifecycle.md) and [product policies](product.md#identity-changes-and-account-linking) define guest separation, usernames/avatars, deliberate OAuth linking, and history/deletion scope. P3-02 adds the [Better Auth session foundation](development.md#account-session-foundation): generated PostgreSQL persistence, a protected Fastify bridge, safe session projection, validated configuration, and an account resolver. P3-03 adds the [verified email/password API](development.md#emailpassword-api), configurable SMTP delivery, safe callback destinations, resend throttling, and password recovery with session revocation. Database-backed lifecycle tests and isolated mailboxes cover delivery failures, token expiry/reuse, concurrent reset, origins, cookies, and redaction. P3-04 adds the [Google/GitHub OAuth API](development.md#google-and-github-oauth), verified provider-email admission, unique provider identities, bound state/PKCE callbacks, safe redirects, and discarded provider tokens. Real-service tests use injected OAuth transports; live console/consent checks remain deployment work. Implicit linking and recovery-based password addition are blocked. Account UI, profiles, and gameplay ownership remain subsequent milestones.

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
- extend database-enforced unfinished-game slots to non-owning human participants and resolve shared-participant retention/deletion before enabling joins;
- authorization and privacy tests.

Exit condition: two separate browser sessions can complete or abort a private game and recover correctly from disconnections.

## Phase 5 — Analysis, polish, and release hardening

Deliverables:

- Stockfish Web Worker analysis after every move;
- live and post-game evaluation graph;
- richer commentary, attempt, latency, token, and estimated-cost views;
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
