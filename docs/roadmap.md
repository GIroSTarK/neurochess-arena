# MVP roadmap

**Status:** Phases 0–3 and the Sandbox presentation remake completed

**Last updated:** 2026-10-04

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

**Status:** Completed

Completed milestones: P3-01 introduces the server-derived principal and identity validity/locking boundary while preserving guest authorization, expiry, controller cleanup, and independent Sandbox limits. The [accepted identity ADR](decisions/0013-server-derived-principals-and-account-lifecycle.md) and [product policies](product.md#identity-changes-and-account-linking) define guest separation, usernames/avatars, deliberate OAuth linking, and history/deletion scope. P3-02 adds the [Better Auth session foundation](development.md#account-session-foundation): generated PostgreSQL persistence, a protected Fastify bridge, safe session projection, validated configuration, and an account resolver. P3-03 adds the [verified email/password API](development.md#emailpassword-api), configurable SMTP delivery, safe callback destinations, resend throttling, and password recovery with session revocation. Database-backed lifecycle tests and isolated mailboxes cover delivery failures, token expiry/reuse, concurrent reset, origins, cookies, and redaction. P3-04 adds the [Google/GitHub OAuth API](development.md#google-and-github-oauth), verified provider-email admission, unique provider identities, bound state/PKCE callbacks, safe redirects, and discarded provider tokens. Real-service tests use injected OAuth transports; live console/consent checks remain deployment work. Implicit linking and recovery-based password addition are blocked. P3-05 extends the [game API](development.md#ai-provider-and-game-api) to normalized account ownership and human-seat assignments, database-enforced public game limits across sessions, session-specific command/AI fencing, and explicit cross-device paused recovery. Private snapshots, configuration, invocations, replay, and PGN follow account authority; guest games and the independent guest-only Sandbox remain separate. Populated-schema migration and real-auth/PostgreSQL tests cover races, revocation, late results, and restart cleanup. P3-06 adds the private [profile API](development.md#profile-api), PostgreSQL-enforced normalized usernames, safe provider avatars and sticky removal, and required username onboarding for every account game/provider operation. Password, Google and GitHub follow the same profile lifecycle; profile changes preserve immutable owner/seat authority. P3-07 adds the localized [account UI](development.md#account-ui): email registration/verification/resend, sign-in, password reset, Google/GitHub entry points, username onboarding, removable provider avatars, profile editing and sign-out. Public gameplay waits for session/profile resolution and carries explicit identity intent plus a server-checked expected-account assertion. Identity changes abort requests/controllers, clear page-owned secrets and private data, and fence stale results; return to unfinished games remains paused and explicit. Desktop/mobile real-service fixtures cover email/OAuth journeys, account games, cross-tab switching, reset invalidation, key loss, safe navigation, keyboard and expanded-copy layouts. P3-08 adds the private [saved credential API](development.md#saved-credential-api): explicit encrypted saving, bounded metadata lists, individual revocation and scoped clearing. Versioned AES-256-GCM envelopes bind owner/provider/record context; PostgreSQL tests cover plaintext absence, privacy, duplicate/capacity races, session expiry rollback, deletion and populated-schema upgrades. Key-loss and rotation requirements are documented. P3-09 adds exclusive session-key/saved-reference contracts and authorized saved-key resolution for discovery and AI turns across all four adapters. Owner/provider-scoped reads precede API-only decryption; revocation blocks later discovery pages, inference and retries, while already-dispatched results follow the accepted account/game/controller fences. Credential failures pause without technical losses or budget resets, and explicit session-key recovery remains available. Real-auth/PostgreSQL fixtures cover adapter operations, privacy, unavailable envelopes, revocation races, duplicate commands and stale outcomes. P3-10 adds the [credential settings and recovery UI](development.md#credential-ui): explicit opt-in saves, labeled masked metadata, confirmed individual revocation/clear, and independent saved-reference or session-only selection for either AI seat. Source changes cancel discovery; identity changes and pagehide clear secrets and selections; unavailable keys recover through explicit Resume/Next move. Desktop/mobile real-service fixtures cover both human colors, source combinations, refresh, revocation, undecryptable/rejected keys, account switching, privacy and accessibility. P3-11 adds [private history and result navigation](development.md#private-game-history): bounded account-only cursor pagination, completed/aborted state labels, localized empty/error/guest states, and existing private replay/commentary/PGN access across sessions. History excludes unfinished, guest and Sandbox games; identity changes clear rows and terminal viewing never requests controllers or credentials. PostgreSQL and desktop/mobile tests cover privacy, precision/tie pagination, replay/export agreement and responsive accessibility. P3-12 adds [individual terminal game deletion and history clearing](development.md#private-game-history), with separate Cancel-first confirmations and explicit retry behavior. Account-scoped transactions cascade through all game records, serialize with creation/completion, and preserve unfinished games, credentials, profiles and other identities. PostgreSQL tests cover complete cascades, rollback, session expiry, concurrent reads/writes and late provider outcomes; desktop/mobile flows cover confirmation, unconfirmed requests, refreshed history, deleted private URLs and accessibility. P3-13 adds [account deletion](development.md#account-deletion) with recent password/OAuth session proof, explicit confirmation, atomic application/auth cleanup, account-bound verification links and fences against in-flight provider work. PostgreSQL tests cover cascades, rollback, lock-wait expiry, stale and multiple-device sessions, paused recovery and late inference; desktop/mobile checks cover Cancel-first confirmation, private-state clearing and honest uncertain outcomes. P3-14 completes the [account lifecycle acceptance coverage](development.md#account-lifecycle-acceptance), including both account AI modes through independent-device sign-in, original-session expiry, explicit credential recovery, completion and private history/PGN access. Fresh installation, repeated and populated-schema migrations, the configured baseline, desktop/mobile Chromium suites and built-service startup pass. Live OAuth/email/provider and deployment verification remain outside these deterministic fixtures; Phase 4 and Phase 5 retain their scope.

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

**Status:** In progress

- [x] Step 0: align Arena profile-access cleanup and Sandbox request privacy, and validate the secure API origin at startup. See the [controller access policy](architecture.md#ai-controller-presence-and-recovery), [Sandbox transport](architecture.md#sandbox-web-client), and [environment contract](development.md#environment-contract).
- [x] Step 1: share HTTP transport, request identity, and game-response validation across clients; separate the Sandbox client behind the shared game-command interface and preserve its build boundary. See the [client transport architecture](architecture.md#sandbox-web-client).
- [x] Step 2: extract the shared gameplay helpers, archive controller, failure classification, and PGN delivery; rename the Sandbox feature and its adapters, share result formatting, and enforce the gameplay/feature boundary. See the [gameplay architecture](architecture.md#sandbox-web-client).
- [x] Step 3: split the Arena controller into a facade, typed store, session coordinator, and collaborators for leases, AI turns, commands, telemetry, and credentials; publish command availability in subscribed state and cover the collaborators without a DOM. See the [Arena controller architecture](architecture.md#ai-controller-presence-and-recovery).
- [x] Step 4: thin `MatchScreen` with a pure, Node-tested presentation projection and feature-owned header, board, and details adapters; move `AiControls` into the match feature and give shared labels neutral localization keys. See the [Arena presentation architecture](architecture.md#ai-controller-presence-and-recovery).
- [x] Step 5: share route-data validation, action scopes, result fences, and revalidation helpers; split Auth and Account actions, move routes and profile UI to their owning features, and enforce declared cross-feature imports. See the [routing architecture](architecture.md#browser-routing).

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
