# Product specification

**Status:** Draft for MVP implementation  
**Last updated:** 2026-09-02

## Vision

Neurochess Arena is a public web application where people can configure different large language models, watch them play chess, and compare how they reason about the same position. The defining experience is not merely playing chess against a bot; it is observing AI-versus-AI competition with enough context to understand performance, behavior, speed, and cost.

## Primary audience

The product is accessible to a broad audience, with AI enthusiasts as the primary early users. Secondary audiences include chess players curious about LLM behavior and developers evaluating models.

## Product goals

1. Make it simple to run a fair AI-versus-AI chess game using user-selected models.
2. Make every game understandable through moves, concise model commentary, Stockfish evaluation, latency, token usage, and estimated cost.
3. Support three polished modes: AI versus AI, AI versus human, and private online human versus human.
4. Protect user-provided provider credentials through an explicit bring-your-own-key security model.
5. Establish a foundation that can later support more locales and time-controlled chess.

## MVP non-goals

- Ratings or ranked matchmaking
- Tournaments
- Chat
- Social feeds, follows, reactions, or other social features
- Payments or subscriptions
- Public live spectators
- Custom model system prompts or personalities
- Chess clocks or provider-response time controls
- Arbitrary FEN starting positions or chess variants

## Roles

### Guest

A guest can:

- start AI-versus-AI and AI-versus-human games using session-only API keys;
- join a private human game through an invitation link or code;
- recover an unfinished game after a page refresh through a guest session in the `paused` state, but must re-enter any API key;
- have only one game in the `active` or `paused` state at a time.

A guest cannot:

- create a human-versus-human room;
- save API keys;
- retain completed games in account history.

### Registered user

A registered user can do everything a guest can and can also:

- maintain a unique username and avatar;
- create a private human game and send an invitation;
- retain private game history;
- optionally save provider keys in encrypted form;
- delete an individual game, clear all game history, or delete the account and associated data.

Registration supports email/password, Google, and GitHub. Email verification and password reset are required for email/password accounts.

## Game modes

### AI versus AI

This is the flagship mode.

The user configures White and Black independently:

- provider;
- model selected from the provider's current model list;
- supported parameters such as temperature, reasoning effort, and maximum output tokens;
- either a session-only provider key or an explicitly saved credential.

The same provider and model may be selected for both colors. The game starts from the standard initial chess position and has no chess clock. The user can pause, resume, request the next move, adjust playback speed, or stop the game.

An AI game does not continue in the background after its controlling browser tab is closed. It is restored in a paused state when the session returns.

### AI versus human

The user selects their color and configures the AI opponent with the same provider, model, parameter, and credential controls used by AI-versus-AI mode. The chess engine validates human and AI moves. The game has no chess clock.

### Human versus human

A registered user creates a private room, chooses their color, and shares an invitation link or code. A registered user or guest can join. There is no public room directory or automatic matchmaking.

If a participant disconnects, the game remains available for reconnection without a time limit. The room owner may close the active room; this marks the game as `aborted` rather than deleting the record. Completed and aborted games appear in the history of registered participants. A guest has no durable history.

The [local development sandbox](architecture.md#local-development-sandbox) supports the one-browser implementation checkpoint and is outside these three public game modes.

**Current implementation checkpoint (PR 2):** the sandbox has a guest-cookie bootstrap, private snapshots, and persisted human moves through the API. Development/test guest access expires after 24 hours of inactivity by default, configurable on the server. Snapshots preserve the stored lifecycle; refresh-to-paused recovery, resume/abort controls, the gameplay UI, and replay/export endpoints are not yet implemented. This does not change the MVP recovery requirements or decide production guest retention; automated expiry cleanup remains follow-up work.

## Chess and AI behavior

### Source of truth

A deterministic chess rules engine owns the position, legal move generation, and result detection. The MVP uses standard chess move legality, including castling, en passant, and all promotion choices. It supports checkmate, stalemate, insufficient material, human resignation, and the automatic draw policy below.

AI models cannot resign in the MVP.

### Automatic draw policy

All three game modes and the development sandbox use the same automatic adjudication. Neither a person nor a model submits a draw claim, and play cannot continue after a draw threshold is reached.

| Condition after an accepted move                                | Outcome                        |
| --------------------------------------------------------------- | ------------------------------ |
| The current position occurs for the third time                  | Draw by threefold repetition   |
| 100 consecutive half-moves occur without a pawn move or capture | Draw under the fifty-move rule |

A half-move is one move by one side: 100 half-moves means 50 moves by each side. A pawn move or capture resets that counter. Repetition counts positions across the complete game, including the initial position; occurrences need not be consecutive. Position equality includes side to move, piece placement, castling rights, and legal en passant availability.

Evaluate results before allowing the next turn, in this order: checkmate, stalemate, insufficient material, threefold repetition, then the fifty-move rule. Checkmate on the accepted move takes priority even at the half-move threshold. A draw records `completed`, result `1/2-1/2`, and its specific termination reason. Pausing, restoring, or replaying a game never resets its history or counters.

This policy keeps the model's action limited to selecting a legal move and requires no draw-claim or draw-offer flow. It deliberately differs from the FIDE claim procedure: articles 9.2–9.3 use claims for threefold repetition and fifty moves, while article 9.6 provides automatic draws at fivefold repetition and 75 moves. Arena finishes at the earlier thresholds. See the [FIDE Laws of Chess, article 9](https://handbook.fide.com/chapter/e012023).

### Model input

Each model receives the same relevant chess context:

- current FEN;
- complete PGN up to the current move;
- the model's color;
- the legal move list;
- the standard Neurochess Arena response instruction.

Models do not receive:

- Stockfish evaluation or suggested lines;
- opponent commentary;
- opponent provider or model identity.

### Model output

The normalized response contract is:

```json
{
  "move": "e2e4",
  "commentary": "Controls the center and opens development lines."
}
```

`move` is required and uses UCI notation. `commentary` is an optional, concise explanation intended for the viewer; it is not hidden chain-of-thought. Missing commentary does not invalidate an otherwise legal move and is displayed as `No commentary provided`.

### Failure policy

- A schema-invalid response, unknown move, or illegal move is retried automatically up to two times after the initial attempt.
- A third invalid result ends the game as a technical loss for that model.
- A provider, network, authentication, quota, or timeout failure pauses the game and allows the user to retry. It does not count as an invalid chess response or technical loss.
- Retry attempts and terminal reasons are visible in the game event history.

## Live game experience

The game screen shows:

- interactive chessboard;
- players, colors, providers, and model names where applicable;
- move list;
- concise commentary for each AI move;
- live Stockfish evaluation after every move;
- evaluation graph;
- response latency per AI move;
- input, output, and total token usage when reported by the provider;
- estimated per-move and cumulative cost when pricing information is available;
- provider errors and retry state;
- pause, resume, next-move, speed, and stop controls where relevant.

Cost is explicitly labeled as estimated. If reliable usage or pricing metadata is unavailable for a model, the UI displays an unavailable state rather than inventing a value.

## Post-game experience

The result page provides:

- interactive move-by-move replay;
- Stockfish evaluation graph;
- model commentary associated with moves;
- token, estimated cost, and latency totals and per-move details;
- final result and termination reason;
- PGN copy and download.

Saved games are private in the MVP. There are no public game or live spectator links.

## Game lifecycle

The canonical game states are:

```text
configuring -> active <-> paused -> completed
                    \-----------> aborted
```

`completed` includes normal chess results and technical losses. The termination reason distinguishes checkmate, draw type, human resignation, and model technical loss.

Only one game may be `active` or `paused` for a given authenticated user or guest session.
Paused games count toward this limit. Completion or abortion releases the slot. Completed and aborted games reject further moves; replay does not modify their accepted positions or result.

## Localization and responsive design

English is the only shipped MVP locale, but user-facing strings must use a localization layer from the beginning. The interface is desktop-first and fully usable on smartphones. The visual direction is a dark, futuristic AI arena with a highly legible chessboard and accessible controls.

The [design system](design-system.md) defines the refined sci-fi visual language, semantic tokens, component states, accessibility rules, and [desktop/mobile core journey concepts](design-system/concepts/README.md). It guides implementation of the existing MVP scope; the concepts use fictional models and illustrative telemetry.

## MVP acceptance criteria

The MVP is ready when:

1. All three game modes work end to end on supported desktop and mobile browsers.
2. OpenAI, Anthropic, Google, and OpenRouter can list models and complete legal turns through a shared provider contract.
3. AI-versus-AI supports independent White and Black configuration and all live controls.
4. Authentication, private rooms, invitation joining, reconnection, and private history work as specified.
5. Replay, Stockfish analysis, telemetry, and PGN export work for completed saved games.
6. Session-only and saved API keys meet the security rules in ADR-0004.
7. Automated tests cover the critical chess, provider, authorization, persistence, and realtime flows.
8. The application has a polished, coherent, accessible dark UI and no known release-blocking defects.

## Open product decisions

- Avatar source and whether custom avatar uploads are included in the MVP
- Exact retention period for an inactive guest game
- Exact supported parameter matrix for each provider and model
- Whether an aborted game should be visually grouped separately from completed history
- Final deployment platform and production region
- Repository license
