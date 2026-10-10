# ADR-0019: Browser analysis and private samples

**Status:** Accepted  
**Date:** 2026-10-10

## Context

All three public modes require live evaluation and private post-game graphs. Browser analysis can finish after another move, identity change, or deletion; room participants can submit different evaluations. Engine output must remain outside chess authority and model prompts. The worker and persistence implementations need one policy before either ships.

## Decision

The [analysis architecture](../architecture.md#stockfish-worker) owns the profile, resource limits, sample contract, scheduling, and deletion protocol. The [product policy](../product.md#stockfish-analysis) and [presentation rules](../design-system.md#stockfish-analysis) define what viewers see.

- Self-host the pinned `stockfish@19.0.0` lite single-threaded WASM distribution, lazily loaded in at most one worker per mounted game view. Use one fixed, versioned profile across devices; no CDN execution, server analysis, threaded fallback, or automatic full-engine download. The maintainer describes the lite single-threaded build as smaller and independent of cross-origin isolation, with weaker analysis than the full engine. This is a compatibility choice, not measured Arena performance evidence. [Build guidance](https://github.com/nmrugg/stockfish.js#the-engines)
- Analyze the initial position and every accepted move prefix asynchronously, prioritizing the displayed position while reserving bounded work for historical gaps. Analysis failure cannot block rendering, commands, recovery, or replay. Never feed scores, lines, or engine moves to an LLM or the command service.
- Store exact reported centipawn or mate scores relative to White, with achieved depth, immutable engine/configuration provenance, and verified history identity. No principal variations, best-move display, coaching actions, win probabilities, or synthetic scores from game results in the MVP.
- Persist at most one untrusted sample per account/game/ply. Each account reads only its own samples, including in rooms; guests and Sandbox use page memory. Current access must authorize every read/write. Removing a room participant's retained access removes that participant's samples in the same transaction, even while the opponent retains the canonical game.
- Replacement follows server-owned profile ordering and achieved depth, with the first committed sample winning ties. Older labelled samples remain readable until replaced. Analysis metadata never advances game revisions, receipts, terminal ordering, or PGN.

### Distribution and licensing

Repository review finds no selected license: [README](../../README.md#license) and [open product decisions](../product.md#open-product-decisions) leave that choice to the project owner. This ADR does not select it or assume that a worker boundary settles application-license compatibility.

Stockfish requires corresponding source for the exact distributed engine and GPL terms for engine modifications. Ship the engine's license, copyright/author notices, matching source including networks and build inputs, and reproducible build instructions alongside its assets. Provide a visible engine/source/license link and retain source availability for each distributed version; an unversioned upstream link is insufficient. [Stockfish distribution guidance](https://stockfishchess.org/about/#about-the-gpl)

P5-02 must record the package integrity, exact source revision, JS/WASM/network hashes, compiler/build options, and any modifications in the distributable manifest, and verify that the source reproduces the selected engine. npm's reported source revision and the release tag are different identifiers; do not assume the tag alone identifies the package bytes. Release packaging must include these materials, and public distribution remains gated on the owner's repository-license decision and compatibility review. No engine assets or license changes ship in P5-01.

## Consequences

Room participants may see different, explicitly client-computed scores. Per-account samples avoid silently promoting another viewer's output to trusted analysis, at the cost of duplicate computation/storage. Depth and provenance make interrupted backfill and version changes visible; they do not make client scores authoritative or device timings comparable. Hidden tabs do no analysis, and slow or unavailable engines leave honest gaps while chess continues.

## Alternatives considered

| Alternative                                        | Reason not selected                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Full or threaded Stockfish                         | Greater strength, but larger transfer or cross-origin-isolation requirements; revisit only with measured need and a new profile/policy review  |
| CDN-hosted or server-side analysis                 | Adds a third-party runtime dependency or private-position processing and server cost; self-hosted browser execution fits the existing boundary |
| Shared game/ply samples                            | Saves work, but lets one participant supply another's displayed evaluation and complicates independent deletion                                |
| Memory-only account analysis                       | Simplifies storage, but loses saved analysis on reload and repeatedly recomputes private replay                                                |
| Every profile/sample retained, or last writer wins | Grows storage without bound or lets stale tabs overwrite newer analysis; one ranked sample per account/game/ply is sufficient                  |
| Principal variations and suggested moves           | Expands the requested evaluation into coaching; omit from both transport and UI                                                                |

This extends [ADR-0002](0002-deterministic-chess-authority.md), [ADR-0007](0007-lifecycle-recovery-and-private-replay.md), and [ADR-0018](0018-private-room-lifecycle-and-shared-retention.md) without changing their authority, replay, or retention guarantees. Track implementation separately in the [roadmap](../roadmap.md#phase-5--analysis-polish-and-release-hardening).
