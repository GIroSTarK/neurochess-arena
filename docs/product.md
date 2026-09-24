# Product specification

**Status:** Draft for MVP implementation  
**Last updated:** 2026-09-24

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
- have only one game across the public modes in the `active` or `paused` state at a time.

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

### Email account lifecycle

Email/password accounts must verify their address before signing in. Registration and verification never sign in automatically. Passwords have 12–128 characters, preserve spaces, and require no particular character classes. Resetting a password revokes every existing account session; the user must sign in again with the new password. A reset does not itself verify an unverified email address.

Verification links expire after one hour; reopening an unexpired link is harmless and creates no session. Password-reset links expire after one hour and can be used only once. Registration, verification resend, and reset requests return generic acknowledgements without disclosing whether an address is registered. An acknowledgement does not promise delivery to an unknown or already-verified address. Delivery failures return a retryable error, and an unverified account can explicitly request another verification email. Sign-out revokes only the current session.

### Identity changes and account linking

Guest games remain separate from accounts. Signing in never imports or transfers guest games, their human seats, or their unfinished-game slot. Explain this before sign-in. The original guest session retains its existing access until expiry; an account does not gain that authority because the browser also holds a guest cookie.

On public account-capable routes, a valid account session takes precedence over a guest session. An expired or invalid account operation fails authentication; it must not silently become a guest operation or create a replacement guest game. Starting or returning to guest play requires an explicit guest action after leaving the account context. Development Sandbox continues to use only its guest identity and independent slot.

Sign-in, sign-out, and account switching end the old page's requests and controller heartbeats, clear page-owned provider keys and private state, and fence obsolete responses. They do not transfer or resume a game. Returning to an unfinished game, including on another device, recovers paused and requires explicit continuation.

OAuth sign-in never implicitly merges accounts with matching email addresses. A conflicting sign-in provides a recoverable path through the existing sign-in method. Linking Google or GitHub requires an explicit action from an authenticated account, a fresh identity check, and successful verification of the provider identity. Never link a provider identity already attached to another account. Do not create a second account to bypass an email conflict.

### Usernames and avatars

All authentication methods require the same user-chosen username onboarding before starting account-owned play. Never derive a public username from an email address without the user's choice. Store a trimmed display value and an ASCII-lowercase normalized value; enforce uniqueness on the normalized value in PostgreSQL. Usernames have 3–24 ASCII characters, begin with a letter, and contain only letters, digits, and underscores. The normalized names `admin`, `administrator`, `api`, `auth`, `guest`, `help`, `moderator`, `neurochess`, `root`, `sandbox`, `security`, `support`, `system`, and `www` are reserved.

Users may change their username under the same validation and uniqueness rules. A successful atomic change releases the old name; names are neither identity keys nor historical aliases. Games, seats, and permissions remain attached to the stable account ID.

Avatars use initials from the chosen username or a validated HTTPS avatar URL supplied by Google or GitHub. Imported URLs must match the supported provider's approved avatar hosts; do not accept arbitrary user-supplied URLs or fetch images on the API server. Users can remove an imported avatar, and subsequent sign-in must preserve that choice. Custom uploads are outside the MVP.

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

### Development sandbox

The [local development sandbox](architecture.md#local-development-sandbox) is a development/test-only flow outside the three public game modes. One guest controls both colors; only explicit Start bootstraps a guest.

Sandbox has an independent limit of one active or paused game per guest session. A session may therefore keep one unfinished public-mode game and one unfinished Sandbox game at the same time. Creation conflicts and unfinished-game recovery stay within their respective group; Sandbox actions do not change the public-mode game.

Arena is the default page at `/`, with AI-versus-AI observation, AI-versus-human play with either color, and private game recovery at `/?game=<uuid>`. The development flow lives at `/sandbox`, with its own navigation item only when `SANDBOX_ENABLED=true`. Disabled Sandbox URLs show an unavailable page without starting sandbox requests. Game links use `/sandbox?game=<uuid>`.

- Pause and Resume preserve the position and history. Abort stops play without awarding a win or loss. Resign White and Resign Black award the opposite color a win, including while paused or off-turn. Abortion and resignation require confirmation.
- Refresh or reopening recovers unfinished games as paused, preserving move history and draw counters; Resume is explicit. Uncertain commands preserve the accepted position and block further commands until synchronization or an explicit retry of the identical command.
- Completed and aborted games show the result and reason, read-only replay starting at the final position, and private PGN copy/download. New game does not delete the previous record; its URL remains accessible only to the owning guest session until access expires. There is no guest history list.

The [sandbox walkthrough](development.md#sandbox-ui) documents controls, URL navigation, and configurable access expiry. Production retention and automated cleanup remain separate decisions. Implementation progress belongs in the [roadmap](roadmap.md).

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

### Private history and deletion

Account history lists completed and aborted public games together, newest first, with explicit state/result labels. Unfinished-game recovery is separate. Sandbox and temporary guest games never enter account history. Phase 3 history covers account-owned AI games; registered room-participant history and shared-game retention belong to Phase 4.

Individual game deletion and history clearing affect only terminal account-owned games and their associated moves, participants, command receipts, AI turns, invocations, reservations, and controller records. Active or paused games must first be stopped through the existing lifecycle controls. Clearing history preserves unfinished games, profiles, and saved credentials. Each deletion flow explains its exact scope and requires a distinct confirmation.

Account deletion is a separate confirmed operation that removes the account, its saved credentials, profile, owned games (including unfinished games), associated application data, and authentication data. It invalidates sessions and fences in-flight work so late results cannot recreate deleted records. Separate guest identities and other accounts remain unaffected. Shared human-game deletion/retention must be decided before Phase 4; database deletion does not claim to remove external backups.

## Game lifecycle

The canonical game states are:

```text
configuring -> active <-> paused -> completed
                    \-----------> aborted
```

`completed` includes normal chess results and technical losses. The termination reason distinguishes checkmate, draw type, human resignation, and model technical loss.

Only one game across the three public modes may be `active` or `paused` for a given authenticated user or guest session. The [development sandbox](#development-sandbox) has a separate limit.
Paused games count toward this limit. Completion or abortion releases the slot. Completed and aborted games reject further moves; replay does not modify their accepted positions or result.

Room joining must extend this invariant to non-owning participants before Phase 4 ships; an owner-only constraint is insufficient for that flow.

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

- Exact retention period for an inactive guest game
- Exact supported parameter matrix for each provider and model
- Shared human-game deletion and retention for registered participants in Phase 4
- Final deployment platform and production region
- Repository license
