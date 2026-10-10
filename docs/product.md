# Product specification

**Status:** Draft for MVP implementation  
**Last updated:** 2026-10-10

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
- recover an unfinished AI game after a page refresh through a guest session in the `paused` state, but must re-enter any API key; human-room recovery follows the [room lifecycle](#human-versus-human);
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

### Email/password lifecycle

Email/password sign-in requires a verified email. Registration and verification do not sign the user in automatically. Passwords must contain 12–128 characters; allow spaces and Unicode without composition rules. Registration does not select a public username or complete profile onboarding.

Verification and password-reset links expire after one hour. A repeated valid verification link is idempotent and never creates a session. A reset token can change the password only once, including concurrent submissions. A successful reset revokes every existing account session and requires explicit sign-in with the new password; resetting an unverified account does not bypass email verification.

Registration, verification resend, and reset initiation acknowledge request receipt without confirming account eligibility or email delivery. Their public acknowledgement is the same when delivery succeeds or fails, and does not wait for SMTP completion. Delivery failures are reported internally without account details or secrets. If no email arrives, wait a minute and explicitly request a new link; a registration account can already exist even when its email did not arrive. Validation, origin, rate-limit, and authentication-service failures retain their normal errors. Sign-in does not send mail automatically. Sign-out revokes the current session.

### Identity changes and account linking

Guest games remain separate from accounts. Signing in does not import or transfer guest games, their human seats, or their unfinished-game slot. Explain this before sign-in. Guest access remains governed by the original guest session; an account request gains no guest authority merely because both cookies exist.

On public account-capable routes, a valid account session takes precedence over a guest session. A failed or expired authenticated operation requires sign-in or an explicit return to guest play; it must not silently become a new guest game. The development Sandbox remains explicitly guest-only, including when an account cookie is present.

Sign-in, sign-out, account switching, and session expiry end the old page's controller activity, cancel obsolete requests, clear page-owned provider keys and private state, and fence late responses. Returning to any unfinished AI game requires paused recovery and explicit continuation. Signing in never starts background play.

Do not automatically merge password, Google, or GitHub accounts because their emails match, even when a provider reports a verified email. A conflict guides the user to their existing sign-in method or password recovery without granting access to that account. Linking another method requires a deliberate action from the signed-in account and fresh proof of control of both the existing account and the new method; matching email alone is insufficient.

### Google and GitHub sign-in

OAuth sign-in requires a valid email currently reported as verified by the provider. Missing, malformed, or unverified email fails without creating an account or session; the user must correct it at the provider or use their existing sign-in method. GitHub's email API must verify the selected address, including when the public profile hides it.

The immutable Google subject or GitHub user ID identifies a returning account. A changed verified provider email does not merge accounts or overwrite the local email/profile, even if it matches another account. Provider names never select a public username; only validated provider avatars may initialize the avatar, and later sign-ins preserve removal.

Account linking remains unavailable until a flow proving control of both methods is supplied. Password recovery applies only to an existing password method; it must not add a password to an OAuth-only account. Reset initiation keeps the same generic acknowledgement for those accounts. Canceled consent, invalid/expired callbacks, and provider failures require an explicit new sign-in attempt; no automatic retries create a session.

### Usernames and avatars

Every authentication method uses the same username onboarding requirement before account gameplay. The user chooses the name; neither an email address nor an OAuth display name silently becomes the username.

- Trim surrounding whitespace, then require 3–24 ASCII letters, digits, or underscores. Preserve the chosen letter case for display and store a lowercase normalized value with database-enforced uniqueness. Reject other characters instead of transliterating them.
- Reserve the normalized names `admin`, `administrator`, `api`, `arena`, `auth`, `guest`, `help`, `login`, `logout`, `moderator`, `neurochess`, `root`, `security`, `support`, `system`, and `www`.
- Users may change their username subject to the same validation and uniqueness rules. A successful atomic change releases the old name; a failed change preserves it. Ownership and human-seat authority use immutable account IDs, never usernames. No rename cooldown or old-name redirect is required in Phase 3.
- Use initials by default, or a validated HTTPS avatar URL supplied by the user's Google/GitHub authentication provider on an allowed provider host. Treat avatar metadata as untrusted. Users can remove an imported avatar; subsequent sign-ins must respect removal. Custom uploads, arbitrary user-supplied avatar URLs, and API-side image fetching are deferred.

### Private history and deletion

Account history lists completed and aborted public games together, newest first, with explicit state/result labels and private replay access. Keep active/paused recovery separate. Sandbox and temporary guest records never appear in account history.

For solo public games, individual game deletion and clear-history affect terminal account-owned games only, including their dependent game records. Active or paused games must first be stopped through lifecycle controls. Account deletion removes associated application/authentication data, including unfinished solo games and saved credentials, and prevents late work from recreating deleted data. Database deletion does not claim deletion from external backups. The shared-room exception is defined [below](#shared-room-retention).

Game deletion and history clearing have separate explicit confirmations describing the removed game data, with Cancel initially focused. An individual deletion can be repeated safely; a missing or out-of-scope game has the same successful response without revealing its existence. Clear-history includes every page and serializes with that account's game writes: solo games finished before the clear acquires the account lock are removed; games finishing afterward remain. The shared-room policy extends this boundary to completion by either participant. Each explicitly repeated clear takes a new boundary. Neither operation removes unfinished games, saved credentials, profiles, separate guest games, or another account's retained access. A failed acknowledgement requires an explicit refresh or retry; the browser never automatically retries deletion.

Account deletion has its own Cancel-first confirmation in Account, available before profile onboarding too. Password, Google and GitHub users must have signed in within the last five minutes; session renewal does not count as a new sign-in. Otherwise sign in again, return to Account and confirm explicitly. Deletion atomically removes the profile, saved credentials, all owned solo games and their dependent records, every device session, login methods and account recovery records. It fences new commands, controller renewal, provider retries and late outcomes through the account's write lock. Already-dispatched provider requests and charges cannot be undone. Separate guest games and other accounts' identities remain untouched; shared-game effects are defined below.

The browser clears page-owned keys and private state when deletion starts, and confirms deletion only after a successful acknowledgement. A failed or lost acknowledgement shows an unconfirmed outcome and requires an explicit status check or retry; a missing session alone does not prove deletion. Old cookies cannot repeat deletion successfully or access deleted data. A new registration is a separate account, even with the same email: verification links are bound to their original account. External backup retention remains a deployment decision.

#### Shared-room retention

Each registered participant receives their own retained access when seated. Once the game is completed or aborted, that access permits a history entry, direct private reads, replay, and PGN. Room ownership controls closure and invitations; it does not control the opponent's history. A guest receives temporary participant access through the original unexpired guest identity, including terminal replay/PGN, but no account-history entry.

| Operation                     | Requesting participant                                                                              | Other participant and shared record                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Delete one terminal room game | Remove the account's retained access, including direct URL, replay, and PGN access                  | Preserve the other participant's access and the game while anyone remains entitled                                          |
| Clear history                 | Apply the same removal to every terminal retained game at the serialized boundary, across all pages | Preserve unfinished games and the other participant's access                                                                |
| Delete either account         | Remove its access and identifying bindings from every associated room, even previously hidden games | Abort an unfinished room, release both public slots, and retain an anonymized record for any remaining entitled participant |
| Guest identity expires        | Immediately deny all guest reads, commands, subscriptions, replay, and PGN                          | No automatic game result, closure, or seat replacement; a valid owner may still close the room                              |
| Last access ends              | No participant can reopen the record                                                                | Physically delete the terminal game and dependent records under the cleanup rule below                                      |

Deleting history is not account deletion: the opponent can still see the living account's current username in their retained game. Removed access cannot be restored through ownership, a seat reference, an old invitation, a repeated join, or a new registration. A non-owner must wait for completion or resign themselves before removing an unfinished game from history; only the owner can close it without a chess result.

Deleting either account aborts a waiting or active room with result `*`, not a win or loss. A terminal result is preserved if completion committed first. Deletion removes the account's owner/seat/access and other identifying bindings, including any stored username/avatar copies, without retaining a deleted account UUID as a tombstone. Remaining displays use a localized **Deleted player** label. Moves, colors, result, and identity-free PGN can remain for the other participant. Ownership is never transferred; an ownerless retained room is terminal. The other account and its credentials are not deleted.

If both accounts delete, the final deletion removes the shared record; concurrent deletion must have the same outcome. An owner deleting a waiting room leaves no opponent entitled to retention. If the only remaining participant is a guest, preserve the aborted/terminal record only while that guest identity remains valid. Lost cookies, sign-in, and newly bootstrapped guests do not transfer access.

When the final account entitlement is removed from a terminal room with no guest participant binding, physically delete the game in that transaction. Guest-bound terminal records instead pass to cleanup after commit and on periodic/startup sweeps: preserve them while the guest remains valid, and delete once no account entitlement or valid guest remains. Cleanup synchronizes with guest renewal before checking expiry; expiry makes the record immediately eligible with no additional retention grace period. API downtime delays physical cleanup, never access denial. Guest expiry alone does not abort an unfinished game or release its slots: the owner can close it, or account deletion can abort it. This chooses shared-room cleanup eligibility, not a production retention period for unrelated solo guest games or external backups.

Clear-history must serialize with room completion by either player, not just the requester. A room becoming terminal before the clear's shared-room/account boundary loses only that account's access; a room finishing after it remains visible. [The lock protocol](architecture.md#shared-room-write-order) defines that boundary. Reads already in progress may finish with their consistent pre-deletion view; subsequent requests cannot regain removed access. Acknowledged deletion clears the requesting browser's cached views, and subscriptions must stop delivering protected data after access is lost. Downloaded PGNs and copies already delivered to another participant cannot be recalled.

## Saved credential use and revocation

Accounts explicitly choose a saved credential for each AI seat or use a session-only key. A saved reference grants no account, game, seat, or controller authority and is never automatically selected by provider. Recovery still requires an explicit credential choice and Resume or Next move; saving keys does not enable background play.

Revoking or clearing a saved credential prevents future authorized provider dispatches, including discovery pagination and invalid-output retries. An already-dispatched result may complete if its account session, game revision, and controller remain authorized. Revocation cannot undo an upstream request or its charge. Missing, revoked, undecryptable, or provider-rejected credentials cause a recoverable provider-auth failure; a turn pauses without consuming the invalid-output budget. Invalid output already received still counts under the normal three-attempt policy. Stop, session revocation, and controller loss retain their existing outcome fences.

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

If a participant disconnects, the game remains available for reconnection without a gameplay deadline. The room owner may close the room; this marks the game as `aborted` rather than deleting the record. Completed and aborted games appear in the history of registered participants. A guest has no durable history. Indefinite reconnection does not extend a session's validity.

#### Room lifecycle and permissions

Creation requires a valid account session and completed profile. Create one standard-position game in `paused` with separate room admission state `waiting`, reserve the creator's public slot, and assign their chosen color. Waiting is not a new chess state. A successful explicit join assigns the opposite color, reserves the joiner's public slot, consumes admission, and changes the game to `active` in one transaction. White moves first even when the owner chose Black. Revoking an invitation leaves the waiting room and its reserved slot intact.

| Room condition                             | Canonical game state                      | Who can act                                                                                       | Transition                                                                                  | Public slots    |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------- |
| Waiting, one seated owner                  | `paused`                                  | Owner may replace/revoke the invitation or close; eligible invitee may join                       | Join → joined/active; close or owner account deletion → aborted                             | Creator only    |
| Joined, both seats assigned                | `active`                                  | Side to move may move; either player may resign themselves; owner may close                       | Legal play → completed; resignation → completed; close or either account deletion → aborted | Both identities |
| Either/both disconnected, or API restarted | Unchanged waiting/paused or joined/active | Valid connected participants keep their ordinary permissions; returning clients synchronize first | Reconnection does not issue Pause/Resume or advance the game                                | Unchanged       |
| Completed                                  | `completed`                               | Entitled participants may read/replay/export; accounts may delete retained access                 | No return to play or admission                                                              | None            |
| Aborted, including closure before join     | `aborted`, result `*`                     | Same retained-access rules as completed                                                           | No return to play or admission                                                              | None            |

| Capability                                 | Owner                                                               | Joined opponent                                                             | Invitation holder / outsider                                                   |
| ------------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Private board, moves, metadata, replay/PGN | Participant access; terminal reads require retained access          | Same                                                                        | None before successful join                                                    |
| Join the open seat                         | Self-join is rejected                                               | An identical accepted-join retry may recover the same still-authorized seat | One valid account or explicitly bootstrapped guest, subject to its public slot |
| Move / resign                              | Own color only; moves on turn, resignation also off-turn after join | Same                                                                        | None                                                                           |
| Replace/revoke invitation                  | Waiting only                                                        | None                                                                        | None                                                                           |
| Close room                                 | Waiting or active, with confirmation                                | None                                                                        | None                                                                           |
| Delete terminal history                    | Own account's access only                                           | Own account's access only; guests have no history-delete control            | None                                                                           |

No room Pause/Resume, AI controller, provider credential, seat replacement, ownership transfer, or disconnect forfeiture is introduced. Waiting owners cannot resign an absent opponent into a win. An expired guest cannot reconnect as a replacement identity; the owner may close that unfinished game. A disconnected opponent does not prevent the connected player from making their legal move, resigning themselves, or, if owner, closing. Account deletion is the explicit system-abort exception to owner-only closure.

Create/join retries must not create another room or seat. Two competing joins yield one admitted opponent, with no partial slot, seat, or invitation changes for the loser. A retry after lost acknowledgement may recover only the same principal's existing admission; it cannot restore deleted access. The same identity cannot occupy both seats, and valid account precedence cannot be bypassed using its guest cookie.

Room creation uses a server-issued, account-bound operation valid for ten minutes, obtained only by an explicit creation action. Retain at most one pending or consumed creation operation per account. An identical retry within that window returns the original room only while access remains; if it was deleted, the result is unavailable and creates nothing. Expired, replaced, or unknown operations also create nothing. A new explicit creation action may obtain a new operation, subject to the public slot. Account deletion removes this operation too. This retry window is not a waiting-room or invitation expiry.

#### Invitations and entry

An invitation admits exactly one opponent; it never grants a preview, private read, replay, or spectator subscription. Use 32 cryptographically random bytes encoded as a URL-safe link/code, with only a digest stored by the API. It stays usable while the room is waiting unless the owner revokes or replaces it; there is no separate invitation deadline. Replacement invalidates the old value. Join, closure, and account deletion invalidate admission. Only the owner can issue a replacement while waiting; a lost raw value cannot be read back from storage.

Use `/rooms` for setup and `/rooms/join` for link/code entry, followed by the authorized canonical `/games/:gameId` for waiting, play, and replay. A shared link carries the secret only in `/rooms/join#invite=…`. Scrub the fragment before router initialization and retain the value only in page memory; manual codes follow the same policy. Resolve/join through POST bodies, never API URLs. Before join, resolution returns only **joinable** or **unavailable**, without a game ID, identities, colors, board, or history. Opening a link is read-only: joining and guest bootstrap require an explicit action.

Never put invitations in logs, analytics, referrers, router results/history state, browser storage, or authentication return URLs. Token-free room entry paths may be allowlisted as auth returns. Clear the secret on successful join, leaving the entry flow, identity change, or pagehide. Sign-in/onboarding that leaves this flow, including OAuth/full-document navigation, requires reopening the link or pasting the code again; explain that before departure. An authenticated owner returning without the raw value can replace the invitation. Canonical game URLs carry only the game UUID and still require participant authorization.

### Development sandbox

The [local development sandbox](architecture.md#local-development-sandbox) is a development/test-only flow outside the three public game modes. One guest controls both colors; only explicit Start bootstraps a guest.

Sandbox has an independent limit of one active or paused game per guest session. A session may therefore keep one unfinished public-mode game and one unfinished Sandbox game at the same time. Creation conflicts and unfinished-game recovery stay within their respective group; Sandbox actions do not change the public-mode game.

Arena is the default page at `/`, with AI-versus-AI observation, AI-versus-human play with either color, and private game recovery at `/games/<uuid>`. The development flow lives at `/sandbox`, with its own navigation item only when `SANDBOX_ENABLED=true`. Disabled Sandbox URLs show an unavailable page without starting sandbox requests. Game links use `/sandbox/games/<uuid>`.

The same private game path covers live play, paused recovery, and completed/aborted replay. A game UUID grants no access. Old `/?game=<uuid>` and `/sandbox?game=<uuid>` links intentionally show Page unavailable without redirects, guest bootstrap, or unfinished-game discovery, including empty or duplicate `game` values. A `game` query also invalidates a game path. Entry URLs without that parameter keep unfinished-game discovery. Opening a game through the wrong mode preserves the authorized explanation and explicit link; it does not automatically change modes.

In-app links and Back/Forward keep the document open. Leaving a game stops its controller and clears page-owned keys immediately, including while the destination loads; canceling a departure requires explicit recovery. Successful Start preserves its controller and keys while changing to the canonical game path. AI games and Sandbox use paused recovery on reload or return; the human-room flow synchronizes without changing lifecycle.

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

### Stockfish analysis

All three public modes show asynchronous Stockfish evaluation from the initial position and after every accepted move, including live human rooms. The displayed position takes priority; missing historical positions fill while the page is visible. Slow analysis, hidden tabs, unavailable engines, and upload failures do not delay play or change results. Returning to saved replay needs no provider credentials.

Scores favor White when positive and Black when negative; mate names the benefiting color and distance separately. Unknown positions remain graph gaps. Show achieved depth and engine/profile provenance, including older saved analysis and incomplete backfill. A game won by resignation or technical loss is not automatically a Stockfish mate. Evaluation is not a win probability. The MVP exposes scores and graphs only, without principal variations, best-move hints, or coaching actions.

Accounts automatically retain their own client-computed samples with each authorized public game; room participants never receive each other's samples and may see different scores. Guests and Sandbox keep analysis only in page memory. Reloading may recompute missing samples, and signing in does not transfer guest analysis. Removing a participant's retained room access removes that account's samples while preserving the opponent's access and samples; solo game/account deletion removes the corresponding analysis. Existing backup and already-delivered-copy limitations still apply.

Analysis has its own availability and Retry control. Retrying analysis neither retries an AI turn nor resumes a game. Locally computed but unsaved results stay visibly unsaved after a persistence failure. The [accepted policy](decisions/0019-browser-analysis-and-private-samples.md) and [architecture](architecture.md#stockfish-worker) define limits, replacement, and privacy boundaries.

## Game lifecycle

The canonical game states are `configuring`, `active`, `paused`, `completed`, and `aborted`. The existing AI/Sandbox flow is:

```text
configuring -> active <-> paused -> completed
                    \-----------> aborted
```

`completed` includes normal chess results and technical losses. The termination reason distinguishes checkmate, draw type, human resignation, and model technical loss.

Only one game across the three public modes may be `active` or `paused` for a given authenticated user or guest session. The [development sandbox](#development-sandbox) has a separate limit.
Paused games count toward this limit. Completion or abortion releases the slot. Completed and aborted games reject further moves; replay does not modify their accepted positions or result.

Under the [room lifecycle](#room-lifecycle-and-permissions), waiting reserves the owner's slot and joined play reserves both participants' slots, regardless of color or ownership. Terminal transitions release every participant's slot atomically. AI-versus-AI still reserves its owner's slot despite having no human seat. Connection/presence changes neither occupy a new slot nor release an existing one.

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
- Final deployment platform and production region
- Repository license
