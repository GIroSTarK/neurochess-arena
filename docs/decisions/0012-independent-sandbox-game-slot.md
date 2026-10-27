# ADR-0012: Independent development Sandbox game slot

**Status:** Accepted  
**Date:** 2026-09-21

**Scope update (2026-10-27):** [ADR-0013](0013-server-derived-principals-and-account-lifecycle.md) extends identity handling to accounts, and [ADR-0018](0018-private-room-lifecycle-and-shared-retention.md) extends public slots to both room participants. The independent Sandbox limit remains binding; the guest-owner index below records the original implementation.

## Context

ADR-0006 introduced one unfinished owned game per guest while Sandbox was the only creation flow. Ordinary AI games reused that slot. Starting Sandbox with a paused AI game therefore returned the AI snapshot as a creation conflict; Sandbox then offered controls without the AI controller required for Resume. Ordinary discovery could also return Sandbox instead of allowing AI setup.

## Decision

- Keep one active/paused game across all public modes per identity. Development Sandbox has its own independent one-game limit, as defined in the [product specification](../product.md#development-sandbox).
- Replace ADR-0006's owner-only unfinished index with a partial unique index on `(owner_guest_session_id, is_sandbox)`. Retain guest-before-game locking and all game-scoped command, authority, and revision checks.
- Require an explicit ordinary or Sandbox scope for every unfinished-game repository lookup. Creation and discovery use the same scope, so a creation conflict can only recover a game from that group.
- Retain the existing guest identity and server-owned Sandbox marker. Sandbox remains disabled by default and unavailable in production; no client-supplied flag, public mode, or separate guest cookie is introduced.

## Consequences

A guest may keep one unfinished ordinary game and one unfinished Sandbox game. Completing or aborting a game releases only its group's slot. Public AI modes still conflict with each other. Future account and room-participant enforcement must preserve the same distinction.

Migration `0007_separate_sandbox_game_slot.sql` changes only the index. Existing positions, histories, command receipts, configuration, and AI controller records remain unchanged. Stop old API writers, apply the reviewed migration, and restart with the updated API; old unscoped discovery must not run once both slots can be occupied. Reverting to the old index would require resolving guests with both slots occupied first.

## Alternatives considered

- **Remove the Sandbox limit:** allows multiple unfinished Sandbox games without an unambiguous recovery target.
- **Separate guest cookies:** duplicates identity and expiry handling to solve a game-selection problem.
- **Filter only in the browser:** cannot resolve the database constraint or make concurrent creation and API recovery correct.
