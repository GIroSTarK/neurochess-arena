# ADR-0007: Lifecycle command receipts, paused recovery, and private replay

**Status:** Accepted  
**Date:** 2026-09-03

## Context

PR 4 extends ADR-0006's move-only API to pause, resume, abort, and human resignation. Move rows alone cannot deduplicate lifecycle commands. Refresh must preserve repetition history and invalidate outstanding commands without mutating ordinary snapshot reads. Guests also need temporary access to finished games without introducing account history or public links.

## Decision

- Record every accepted move or lifecycle command in normalized `game_commands`, unique by `(game_id, command_id)` and `(game_id, version)`. Backfill existing moves through a forward migration; retain move constraints. Rejected commands reserve nothing. IDs are game-scoped and cannot be reused across command kinds or changed payloads.
- Keep guest-before-game row locking and conflict checks after read authorization. Atomically persist the receipt, lifecycle/result/PGN, and optional move, advancing the aggregate revision once. Abort remains `aborted` with result `*`; human resignation records the opposite color's win. Owner controls and human-seat permissions remain distinct.
- Keep discovery, snapshot, replay, and export reads free of lifecycle changes. The browser discovers an existing identity's unfinished sandbox or reads a UUID game URL, then issues the ordinary versioned pause command. It reconciles at most three active conflicts automatically, preserves uncertain commands for identical retries, and never enables play until paused recovery followed by explicit Resume.
- Use `/?game=<uuid>` as a resource pointer, never a bearer capability. Opening a terminal game requires the same valid owning guest cookie and sandbox policy as all other game reads. Creating a new game does not delete earlier results. Existing inactivity expiry controls access; production cleanup/retention remain follow-ups.
- Expose terminal-only replay and PGN endpoints using full-history restoration and projection verification. The browser keeps replay presentation separate from accepted state. Export preserves canonical PGN text, including its result header and final marker; no identity or commentary tags are added.

## Consequences

Retries cannot repeat lifecycle transitions or append a move under an accepted lifecycle ID. Pausing and resuming never reset chess counters. Replay and export are private, read-only projections of accepted history. No providers, realtime rooms, guest history list, or browser-persisted game state are required.

Stop old API writers before applying the migration and restart with the new API afterward. A rolling deployment with old move-only writers would miss receipts for their newly accepted moves; supporting mixed writers would require a separate compatibility change. Migrations and tests exercise existing move backfill and rollback.

## Alternatives considered

- **Store lifecycle receipts as moves:** rejected because lifecycle changes are not plies and must not alter chess history.
- **Deduplicate lifecycle IDs only in memory or by current version:** rejected because accepted IDs must survive restarts and remain reserved across command kinds.
- **Pause as a side effect of snapshot GET:** rejected because synchronization, replay, and export must not change gameplay.
- **Recover from browser storage or cached FEN:** rejected because the database owns full history and draw counters; the guest cookie supplies identity.
- **Guest history list or public replay links:** outside this checkpoint; private URLs satisfy temporary reopening without changing account/history scope.
