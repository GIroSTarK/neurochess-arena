# ADR-0017: Data router and canonical private game paths

**Status:** Accepted

**Date:** 2026-10-04

## Context

Native page navigation and query-addressed games obscure route ownership and couple browser transitions to controller lifetimes. Navigation must preserve private authorization, immediate cleanup during pending transitions, and the credential owner of a newly started game. Optional development routes must retain request and build isolation.

## Decision

- Use one React Router Data-mode router with explicit route objects, `createBrowserRouter` from `react-router`, and `RouterProvider` from `react-router/dom`. Retain React/Vite and static hosting; no Framework-mode plugin, SSR, or backend migration. Pin React Router 8.4.0, verified against the installed React and Node versions.
- Use `/games/:gameId` and `/sandbox/games/:gameId` for private live play, recovery, and terminal replay. Keep `/` and `/sandbox` for setup/discovery. Follow the [browser route contract](../development.md#browser-routes) for validation, history semantics, and auth returns. Old query-game links become unavailable without redirects or discovery; do not normalize incoming URLs through redirects.
- This supersedes only the query-string browser pointer in [ADR-0007](0007-lifecycle-recovery-and-private-replay.md). Its command receipts, paused recovery, private replay, and retention decisions remain binding.
- Keep the root free of unconditional identity requests. Public account observation sits in its own branch; Sandbox, reference fixtures, invalid targets, and unavailable routes stay isolated. Literal Vite gates preserve exclusion and lazy loading of optional branches.
- Maintain one controller/credential owner per mounted mode layout across entry/game leaves. Register an explicit in-memory handoff before accepted creation navigates. Pending departure ends the old lifetime immediately; cancellation does not restart it. Reopening uses paused recovery. Router cancellation does not prove that an API write or provider request stopped.
- Route loaders/actions will own suitable entry reads and ordinary form submissions as the staged migration proceeds; live gameplay commands and ephemeral credentials remain feature-owned. Progress belongs in the [roadmap](../roadmap.md#navigation-and-route-data-migration--before-phase-4). ADRs 0011, 0013, and 0016 retain their controller-presence, identity, and deletion contracts.
- Scrub incoming auth secrets before router construction; keep results, history state, diagnostics, and persisted state free of secrets and private records. Use localized safe error presentation and explicit fatal reload. Restore scroll through bounded memory keyed by history-entry identifiers, without storing private URLs.

## Consequences

Ordinary internal links and Back/Forward preserve the document. Canonical game links require SPA fallback on the web host, separate from existing JSON API routes with overlapping prefixes. Deployment provider selection and verification remain open. Frontend rollback must retain canonical paths or use a forward fix; old query bookmarks intentionally cease working.

Creation retains keys and one authorized execution sequence. Departure, identity changes, and hard reload retain explicit recovery and key re-entry. No authorization, retention, provider retry, room, or database policy changes.

## Alternatives considered

- Keep native links and a custom history subscription: duplicates navigation ownership and prevents consistent pending-route handling.
- Adopt Framework mode or SSR: adds deployment and backend changes unnecessary for this static client.
- Keep query compatibility redirects: contradicts the accepted no-redirect contract and can accidentally discover another unfinished game.
- Put handoff data or credentials in history state: persists private state beyond its authorized controller lifetime.
