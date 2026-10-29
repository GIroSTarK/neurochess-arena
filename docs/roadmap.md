# MVP roadmap

**Status:** Phases 0–5 completed; MVP release accepted by the deployment owner.

**Last updated:** 2026-10-28

The MVP contains all three game modes. The phases below are completed implementation checkpoints, not separate product editions. Their acceptance summaries describe evidence at phase closure; the current [release checklist](operations.md#mvp-release-acceptance) governs each new release candidate.

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

**Status:** Completed. See the [sandbox walkthrough](reference/browser.md#sandbox-ui) for usage and [verification strategy](architecture.md#verification-strategy) for acceptance criteria. Phase 5 completed the later cross-browser, assistive-technology and performance release work; ongoing verification boundaries remain in [validation limits](design-system.md#validation-limits).

Build the human-command path first. A [local development sandbox](architecture/games.md#local-development-sandbox) lets one guest session play both colors through the real API, database, and chess rules.

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

Use the [design system](design-system.md) to establish the shared presentation foundation for the three public modes.

- [x] define shared entry, live, recovery, and replay patterns for desktop and mobile;
- [x] extract the shared shell, arena layout, participant and game panels behind Sandbox adapters, with an enforced presentation boundary;
- [x] apply the live composition and board-toolbar action hierarchy;
- [x] apply the entry, recovery, and result/replay compositions;
- [x] separate the Arena placeholder from flag-gated Sandbox navigation;
- [x] exercise the shared presentation with explicit human/AI reference scenarios and future panel slots;
- [x] verify design-system consistency and responsive, keyboard, recovery, and replay acceptance.

Exit condition: Sandbox uses the selected arena design, and the same presentation components can serve the upcoming modes through their own data and actions.

## Phase 2 — AI arena core

**Status:** Completed

Completed milestones:

| Milestones  | Delivered outcome                                                                                                                                                                 | Current contract / evidence                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01–P2-04 | Validated AI configuration, authoritative turn reservations, durable invalid-output budgets, private invocation records, protected HTTP operations and request-scoped credentials | [AI turns](architecture/games.md#ai-turns), [failure policy](architecture/games.md#ai-failure-policy-and-invocation-records), [game API](reference/http-api.md#ai-provider-and-game-api) |
| P2-05–P2-08 | OpenAI, Anthropic, Google and OpenRouter discovery/inference adapters with shared normalization and contract coverage                                                             | [Provider boundary](architecture/providers.md#ai-provider-boundary), [adapter documentation](reference/providers.md#openai-adapter)                                                      |
| P2-09–P2-11 | Independent seat setup, AI observation and either human color, live controls, controller leases, explicit credential recovery and private replay                                  | [Controller contract](architecture/games.md#ai-controller-presence-and-recovery), [Arena controller API](reference/http-api.md#arena-controller-api)                                     |
| P2-12       | Replay-linked commentary, telemetry and Events; completed games across the ordered 4-by-4 provider matrix and all four providers against both human colors                        | [Telemetry contract](architecture/providers.md#telemetry-and-cost), [browser acceptance](reference/testing.md#running-acceptance)                                                        |

Phase acceptance used real adapters, API and PostgreSQL with deterministic upstream fixtures. It covered concurrency, late outcomes, privacy/redaction, retry classification, key loss and Sandbox regressions. These fixtures establish integration behavior; live-provider acceptance is recorded under Phase 5.

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

**Status:** Completed

Completed milestones:

| Milestones  | Delivered outcome                                                                                                                              | Current contract / evidence                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-01–P3-04 | Server-derived identities and Better Auth sessions, verified email/password lifecycle, Google/GitHub admission and explicit account separation | [Identity ADR](decisions/0013-server-derived-principals-and-account-lifecycle.md), [account APIs](reference/http-api.md#account-session-foundation)         |
| P3-05–P3-07 | Account-owned games across sessions, public-slot enforcement, profile onboarding and account UI with identity-transition cleanup               | [Game API](reference/http-api.md#ai-provider-and-game-api), [profile API](reference/http-api.md#profile-api), [account UI](reference/browser.md#account-ui) |
| P3-08–P3-10 | Opt-in encrypted keys, authorized dispatch/revocation, explicit seat credential selection and paused recovery                                  | [Saved credential API](reference/http-api.md#saved-credential-api), [credential UI](reference/browser.md#credential-ui)                                     |
| P3-11–P3-13 | Private terminal history/replay, individual/history deletion and atomic account deletion with recent sign-in and late-work fences              | [Private history](reference/http-api.md#private-game-history), [account deletion](reference/http-api.md#account-deletion)                                   |
| P3-14       | Cross-device recovery and completion for both account AI modes, migration acceptance and lifecycle regression coverage                         | [Acceptance coverage map](reference/testing.md#account-lifecycle-acceptance)                                                                                |

Phase acceptance covered fresh/repeated/populated migrations, PostgreSQL races and rollback, deterministic email/OAuth/provider fixtures, desktop/mobile Chromium journeys, the configured baseline and built-service startup. Live services, physical browsers and deployment acceptance were completed separately in Phase 5.

Deliverables:

- [x] Better Auth with email/password, Google, and GitHub;
- [x] email verification and password reset;
- [x] unique usernames and avatars;
- [x] encrypted opt-in provider credential storage;
- [x] extend guest-session ownership, single-game limits, and paused recovery to authenticated accounts;
- [x] durable private game history and result pages;
- [x] individual game deletion, history clearing, credential revocation, and account deletion;
- [x] authenticated recovery using re-entered session-only keys or explicitly saved encrypted credentials.

Exit condition: registered and guest lifecycle rules match the product specification, including deletion and credential-security tests.

## Navigation and route data migration — before Phase 4

**Status:** Complete

- [x] Explicit page/form selection and controller entry, cleanup, and creation handoffs.
- [x] React Router Data mode, canonical private game paths, shared mode lifetimes, and navigation acceptance coverage.
- [x] Shared route identity runtime, public leaf guards, and authentication actions with scoped cache invalidation.
- [x] Arena entry loaders, committed paused recovery, and live creation handoffs without duplicate initial reads.
- [x] Sandbox entry loaders, committed recovery, creation handoffs, and isolated lazy build boundaries.
- [x] History entry/cursor loaders and confirmed deletion actions with scoped cache invalidation and explicit uncertain-write recovery.
- [x] Account/profile and credential loaders/actions, scoped metadata refresh, and explicit uncertain-save reconciliation.
- [x] Complete migration acceptance coverage and final routing audit.

## Web refactoring — before Phase 4

**Status:** Complete

- [x] Step 0: align Arena profile-access cleanup and Sandbox request privacy, and validate the secure API origin at startup. See the [controller access policy](architecture/games.md#ai-controller-presence-and-recovery), [Sandbox transport](architecture/browser.md#sandbox-web-client), and [environment contract](development.md#environment-contract).
- [x] Step 1: share HTTP transport, request identity, and game-response validation across clients; separate the Sandbox client behind the shared game-command interface and preserve its build boundary. See the [client transport architecture](architecture/browser.md#sandbox-web-client).
- [x] Step 2: extract the shared gameplay helpers, archive controller, failure classification, and PGN delivery; rename the Sandbox feature and its adapters, share result formatting, and enforce the gameplay/feature boundary. See the [gameplay architecture](architecture/browser.md#sandbox-web-client).
- [x] Step 3: split the Arena controller into a facade, typed store, session coordinator, and collaborators for leases, AI turns, commands, telemetry, and credentials; publish command availability in subscribed state and cover the collaborators without a DOM. See the [Arena controller architecture](architecture/games.md#ai-controller-presence-and-recovery).
- [x] Step 4: thin `MatchScreen` with a pure, Node-tested presentation projection and feature-owned header, board, and details adapters; move `AiControls` into the match feature and give shared labels neutral localization keys. See the [Arena presentation architecture](architecture/games.md#ai-controller-presence-and-recovery).
- [x] Step 5: share route-data validation, action scopes, result fences, and revalidation helpers; split Auth and Account actions, move routes and profile UI to their owning features, and enforce declared cross-feature imports. See the [routing architecture](architecture/browser.md#browser-routing).
- [x] Step 6: read Sandbox navigation availability from route context; share text links, secret-input visibility/reset handling, Cancel-first confirmations, allowlisted return URLs, and resignation copy while preserving feature-owned lifetimes and command guards.
- [x] Step 7: separate application composition, routing services, and shell presentation; normalize web filenames to kebab-case, give auth entry parsing and navigation types explicit owners, and update source paths and architecture guards. See the [routing architecture](architecture/browser.md#browser-routing) and [filename convention](development.md#dependency-direction).

## Phase 4 — Private online human games

**Status:** Completed (P4-01–P4-10).

[ADR-0018](decisions/0018-private-room-lifecycle-and-shared-retention.md) defines room lifecycle, invitations and shared retention. The [room HTTP API](reference/http-api.md#private-room-http-api) and [WebSocket protocol](reference/http-api.md#private-room-websocket-protocol) support account/guest participants, either owner color, authoritative play, presence, authorized reconnection and private replay/PGN.

P4-10 closed acceptance across independent desktop/mobile browser contexts and PostgreSQL/native sockets: completion/resignation/abort, matching final positions/results/PGN, participant slots, Sandbox isolation, shared-history/account deletion, privacy, expiry, concurrency, missed publications and restart recovery. The configured baseline and browser suite passed at that milestone. Phase 5 added cross-browser release coverage and Stockfish.

Deliverables:

- [x] authenticated room creation and owner color choice;
- [x] unguessable invitation link/code;
- [x] registered or guest join flow;
- [x] authenticated WebSocket snapshot and event protocol;
- [x] server-authoritative turn broadcasts;
- [x] disconnect and indefinite reconnect behavior;
- [x] owner-controlled abort with `aborted` history state;
- [x] extend database-enforced unfinished-game slots to non-owning human participants and implement the accepted shared-participant retention/deletion policy before enabling joins;
- [x] authorization and privacy tests.

Exit condition: two separate browser sessions can complete or abort a private game and recover correctly from disconnections.

## Phase 5 — Analysis, polish, and release hardening

**Status:** Completed (P5-01–P5-15). On 2026-10-26, the deployment owner confirmed completion of the [MVP release acceptance](operations.md#mvp-release-acceptance) for [neurochess-arena.com](https://neurochess-arena.com) and [api.neurochess-arena.com](https://api.neurochess-arena.com), including candidate verification, physical-browser and manual accessibility checks, live services and providers, licensing, monitoring, and backup/recovery. Phase 5 closure is based on that owner confirmation.

Deliverables:

- [x] define the Stockfish analysis and private persistence contract;
- [x] package and verify the bounded Stockfish worker and scheduler;
- [x] persist private account analysis samples with authorization, bounded APIs and deletion safety;
- [x] Stockfish Web Worker analysis after every move;
- [x] live and post-game evaluation graph;
- [x] record versioned per-invocation estimates, normalized billing dimensions and unavailable reasons;
- [x] richer commentary, attempt, latency, token, and estimated-cost views;
- [x] display explicit unavailable states for incomplete pricing or usage data in telemetry views;
- [x] desktop and mobile UX refinement with measured loading/runtime budgets;
- [x] keyboard navigation, rendered contrast, focus, reduced-motion and chart review, with separate manual release acceptance;
- [x] cross-browser end-to-end suite with Chromium CI gates, scheduled Firefox/WebKit CI and separate physical-device release checks;
- [x] production request/socket limits, verified proxy identity and bounded rate-limit recovery;
- [x] production browser/API security headers, dependency audit and verified asset notices;
- [x] encrypted backups, separate secret recovery, isolated restoration, privacy reconciliation and production cutover verification;
- [x] deployment selection, reproducible API/web artifacts, production configuration and isolated rollout rehearsal;
- [x] private operational metrics, actionable alerts, dashboard and isolated failure/recovery drills;
- [x] map all eight product acceptance criteria to automated evidence and explicit live/manual gates in the [release checklist](operations.md#mvp-release-acceptance);
- [x] verify available local release acceptance across the complete browser matrix, migrations, production artifacts, performance, restart/rollback and encrypted recovery; correct the readiness-test race and remote-browser launch instructions found during acceptance;
- [x] complete release acceptance, including physical browsers/accessibility, live services, licensing and operational verification.

Exit condition: every MVP acceptance criterion in `docs/product.md` is verified and no release-blocking defect remains.

## Board-first arena redesign

Presentation follow-up to the completed MVP, tracked in the [approved implementation plan](superpowers/plans/2026-10-28-board-first-arena-redesign.md).

- [x] Task 1: shared container-based geometry, a board that retains its size when the rail appears, compact equal player identities with full-name dialogs, and preserved focus and component state across resizing.
- [x] Task 2: responsive inspector with separate wide/stacked selections, stable commentary dialogs, and preserved move-history scrolling.
- [x] Task 3: near-board AI status, primary lifecycle controls, separate pacing, and compact evaluation with accessible provenance and independent analysis retry.
- [x] Task 4: explicit credential recovery dialog with retained masked page-memory fields, a persistent near-board action, preserved inspector state, and distinct provider/uncertain-command recovery.
- [x] Task 5: near-board room status and recovery, explicit unfilled seats, grouped invitation sharing with focus access, and preserved human-room capabilities and synchronization.
- [x] Task 6: Moves-first replay with synchronized details, secondary PGN actions and primary next-game actions, reconciled shared consumers, and complete automated redesign acceptance across the configured browsers and performance budgets.

## Post-MVP candidates

- chess clocks and provider-response time limits;
- additional locales;
- arbitrary FEN starting positions;
- public spectator links;
- background AI games;
- multiple concurrent games;
- custom model prompts;
- additional AI providers;
- horizontal realtime scaling with shared pub/sub;
- generated OpenAPI documentation, explicitly deferred beyond the MVP. Existing HTTP contracts and route schemas remain authoritative; no delivery date is committed.

Ratings, tournaments, chat, social features, and payments require separate product decisions and are not assumed to be planned.
