# MVP roadmap

**Status:** Phases 0, 1, and 2 completed

**Last updated:** 2026-09-08

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

**Status:** Completed. See the [sandbox walkthrough](gameplay.md#sandbox-ui) for usage and [verification strategy](testing.md#mvp-acceptance) for acceptance criteria. Remaining cross-browser, assistive-technology, and performance work is tracked in the [validation limits](design-system/validation.md) and Phase 5 below.

Build the human-command path first. A [local development sandbox](architecture.md#local-development-sandbox) lets one guest session play both colors through the real API, database, and chess rules.

Deliverables:

- [x] deterministic standard-position chess, full legal move handling, natural results, automatic draws, and full-history restoration;
- [x] server-authoritative guest sandbox with private ownership, one unfinished-game slot, atomic versioned commands, and lifecycle receipts;
- [x] paused recovery, explicit lifecycle controls, private terminal replay, and canonical PGN copy/download;
- [x] localized responsive dark UI, keyboard/touch board interaction, explicit promotion, and accessible controls;
- [x] unit, PostgreSQL integration, and desktop/mobile browser coverage of chess, concurrency, authorization, recovery, replay, and accessibility; see [acceptance requirements](testing.md#mvp-acceptance).

Exit condition: one guest in the development sandbox can complete and replay a deterministic chess game from one browser without AI or realtime rooms, passing the [Phase 1 verification checks](testing.md#mvp-acceptance).

## Phase 2 — AI arena core

**Status:** Completed. Remaining browser/device and accessibility validation limits are tracked in [design validation](design-system/validation.md) and Phase 5 below.

Deliverables:

- [x] shared runtime-validated provider boundary and OpenAI, Anthropic, Google, and OpenRouter adapters with live discovery, conservative capabilities, normalized output/errors/usage, and mocked contract tests;
- [x] independent effective AI seat configuration, normalized invocations, durable leased reservations, atomic move completion, and the shared guest single-game limit;
- [x] turn-wide invalid-output budgets, technical losses, provider-error pause, paused stepping, lifecycle invalidation, and explicit recovery without duplicate provider execution;
- [x] localized setup and complete AI-versus-AI / AI-versus-human flows, including identical models, either human color, playback controls, promotion, and resignation;
- [x] page-memory keys, refresh/offline/API-restart recovery, explicit key re-entry, and per-seat rejected-key correction;
- [x] live retry feedback, private attempt/error history, accepted commentary, reported latency/tokens, and shared replay/PGN controls;
- [x] [acceptance matrix](testing.md#phase-2-acceptance-coverage) through real game APIs/PostgreSQL with mocked provider boundaries, covering all provider pairings, both human colors, failure recovery, privacy, and concurrency;
- [x] manual live-provider smoke for OpenAI, Anthropic, Google, and OpenRouter: the user confirmed completing the [documented procedure](testing.md#opt-in-real-provider-smoke) with each provider and approved the observed behavior on 2026-09-08. Exact model IDs and run configurations were not supplied; this records user-confirmed verification of the tested setups.

Exit condition: guests can complete both AI modes with any supported provider combination, and no model can bypass server-side move validation.

## Phase 3 — Accounts, encrypted credentials, and history

**Status:** Next milestone

Before implementing the affected schema and authorization flows, resolve the [account-transition, deletion, and credential-revocation decisions](product.md#before-phase-3--accounts-and-deletion). Record the chosen behavior in the canonical contracts and an ADR when consequential.

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

Resolve the [guest reconnection decision](product.md#before-phase-4--guest-reconnection) before implementing guest room membership. Extend the single-game invariant to joining, non-owning participants as required by [ADR-0006](decisions/0006-guest-owned-game-commands.md).

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
- richer commentary, attempt, latency, token, and estimated-cost analysis views and totals beyond the basic Phase 2 display;
- explicit unavailable states for incomplete pricing or usage data;
- desktop and mobile UX refinement;
- keyboard navigation, contrast, focus, and reduced-motion review;
- cross-browser end-to-end suite;
- rate limiting, security headers, dependency audit, backup and restore check;
- production guest retention/cleanup and saved-credential encryption-key backup/rotation procedures, as required by [product](product.md#other-open-decisions) and [ADR-0004](decisions/0004-bring-your-own-key-security.md);
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
