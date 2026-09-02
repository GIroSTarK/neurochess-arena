# Design concept fixtures

These fixtures connect the eight [screen concepts](concepts/README.md). They are documentation examples, not model recommendations, provider responses, prices, or benchmark results. **Model A** and **Model B** are fictional labels used with the supported OpenAI and Anthropic provider names.

## One sample game

All games start from the standard initial position. The concepts use a short legal game so every position is reproducible:

```pgn
[Event "Neurochess Arena design fixture"]
[Site "Documentation"]
[Date "2026.09.02"]
[Round "-"]
[White "Model A (fictional)"]
[Black "Model B (fictional)"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1
```

| Concept  | Position                                                           | FEN                                                             |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Setup    | Before play; standard initial position if a board preview is shown | `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`      |
| Live     | After `2. g4`; Black to move                                       | `rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2` |
| Recovery | Same position as Live; game paused after refresh                   | `rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2` |
| Replay   | After `2... Qh4#`; Black wins by checkmate                         | `rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3` |

The live/recovery FEN omits the non-capturable en-passant target; a rules engine that serializes every double-pawn push may emit `g3` instead. Both describe the same legal move set for this fixture.

White is at the bottom. Files run a–h left to right; ranks run 8–1 top to bottom. a8 is light and a1 is dark. There are 32 pieces in every fixture position: this game has no captures. In the live position, only the f2 pawn moved to f3, the g2 pawn moved to g4, and the e7 pawn moved to e5. The final position additionally moves the black queen from d8 to h4.

## Illustrative move data

| Ply | Color | SAN  | UCI  | Input tokens | Output tokens | Total tokens | Latency | Estimated cost | Commentary                                  |
| --- | ----- | ---- | ---- | ------------ | ------------- | ------------ | ------- | -------------- | ------------------------------------------- |
| 1   | White | f3   | f2f3 | 800          | 40            | 840          | 2.1 s   | $0.0011        | Makes space for the king's knight.          |
| 2   | Black | e5   | e7e5 | 1,040        | 60            | 1,100        | 2.4 s   | $0.0016        | Occupies the center and opens the diagonal. |
| 3   | White | g4   | g2g4 | 910          | 50            | 960          | 1.8 s   | $0.0012        | Gains space on the kingside.                |
| 4   | Black | Qh4# | d8h4 | 945          | 55            | 1,000        | 2.2 s   | $0.0015        | The open diagonal allows checkmate.         |

Commentary illustrates what a model might say, including an unhelpful explanation; it is not authoritative chess analysis. All invocation data in this table is synthetic. No real provider prices or requests were used.

| Aggregate               | White / Model A | Black / Model B | Total   |
| ----------------------- | --------------- | --------------- | ------- |
| Completed moves         | 2               | 2               | 4       |
| Input tokens            | 1,710           | 1,985           | 3,695   |
| Output tokens           | 90              | 115             | 205     |
| Total tokens            | 1,800           | 2,100           | 3,900   |
| Summed response latency | 3.9 s           | 4.6 s           | 8.5 s   |
| Estimated cost          | $0.0023         | $0.0031         | $0.0054 |

The live/recovery compact rows show the latest completed move for each color: White's third ply and Black's second ply. The final result summary uses the aggregates. Summed response latency is not elapsed game duration.

Evaluation is presented separately. In the live/recovery position Black has mate in one; the final position is checkmate. A graph may use illustrative centipawn samples for earlier positions, but must label them illustrative and show mate as a separate labeled endpoint rather than an invented numeric score. No Stockfish process was used to claim measured evaluations for these concepts.

## Exact screen copy and states

| Screen       | Required labels and state                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared shell | NEUROCHESS ARENA; Arena; Guest session; Sign in                                                                                                                                            |
| Setup        | Set up a game; AI vs AI; AI vs human; Private room; White; Black; Provider; API key; Model; Advanced parameters; Use for this tab; Cleared when you refresh or close this tab.; Start game |
| Live         | AI vs AI; Black to move; Commentary; Stockfish evaluation; Black mates in 1; Black is choosing a move…; Pause; Next move; 1×; Stop; Moves; Analysis; Events                                |
| Recovery     | Game paused; Re-enter your API keys; Your game was restored after a refresh. Session-only keys were cleared.; White · OpenAI; Black · Anthropic; Use for this tab; Resume; Return to game  |
| Replay       | Black wins by checkmate; 0–1; Move 4 of 4; Stockfish evaluation; Checkmate; Commentary; Moves; Analysis; Events; Match totals; Estimated cost; Copy PGN; Download PGN                      |
| Caption      | Design concept · Fictional models and illustrative telemetry                                                                                                                               |

Set up the guest's two independent session credentials with synthetic masking glyphs only. Never render a plausible raw API key. In recovery, both provider keys are missing; Resume is disabled until the required fields are ready. Return to game dismisses recovery and leaves the game paused. The guest private-room entry explains that sign-in is required to create a room; joining an invitation remains available.

## Review-only edge cases

Use these alongside the primary concepts when implementing components; they do not require extra MVP screens:

- Identical provider/model on both seats, a long model identifier, and 50% longer labels.
- A provider model list that is loading, empty, unavailable, or contains an unsupported model.
- Missing commentary; missing usage; known usage with unavailable price; a genuine zero distinct from unavailable.
- Invalid attempts 1, 2, and 3; authentication/quota/timeout failures that pause without a loss.
- One restored saved credential plus one missing session key; guest recovery with both keys missing.
- Human move pending, a stale command, a disconnected room participant, and an unauthorized action.
- Keyboard focus/selection, legal target and capture, castling, en passant, promotion and underpromotion.
- Checkmate, stalemate, repetition, fifty-move draw, insufficient material, human resignation, technical loss, and aborted game.

See the canonical [design-system state rules](../design-system.md#game-state-and-recovery) for the presentation of these cases.
