# ADR-0002: Deterministic chess engine is authoritative

**Status:** Accepted  
**Date:** 2026-08-15

## Context

LLMs can produce malformed, ambiguous, or illegal chess moves and can incorrectly describe game state. The product aims to compare model choices fairly, so position state and rules cannot depend on a model's claims or on a potentially stale client.

## Decision

- A deterministic server-side chess rules engine is the sole authority for the current position, legal move set, move acceptance, draw rules, and final result.
- Every game starts from the standard initial position in the MVP.
- The server supplies an LLM with legal moves and still validates the returned move.
- UCI is the canonical machine move notation. PGN and SAN are derived presentation/export formats.
- The server persists the accepted move and resulting position atomically.
- Clients may mirror chess logic for interaction feedback, but server validation always wins.
- Stockfish is an analysis tool only. Its evaluation cannot alter legality, game state, or LLM input.

## Consequences

- Illegal LLM output cannot corrupt a game.
- All three game modes use the same result and move-validation rules.
- Concurrency control is required so two requests cannot commit moves against the same position version.
- The chosen chess library must correctly support checkmate, stalemate, repetition, the fifty-move rule, insufficient material, castling, en passant, and promotion.
- Chess variants and arbitrary FEN starts remain outside the MVP but can be added without changing the provider boundary.

## Alternatives considered

### Trust the LLM to produce a valid move

Rejected because move legality and game results would be unreliable and incomparable between providers.

### Use Stockfish as the move authority

Rejected because Stockfish evaluation and best lines are not chess rules, and exposing them would undermine the goal of measuring LLM move selection.
