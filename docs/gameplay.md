# Gameplay walkthroughs

Controls and user flows for the arena and development sandbox. [Product](product.md) owns behavior, the [design system](design-system.md) owns presentation and accessibility, and the [game protocol](game-protocol.md) owns command synchronization and recovery. See the [roadmap](roadmap.md) for delivery status.

## AI setup UI

Open `/` to configure a match. Setup establishes the guest cookie and checks registered providers and the unfinished-game slot. Discovery starts only after a seat's key is entered and **Load models** is selected; it never requests a move.

AI versus AI is initially selected. White and Black have independent provider, key, searchable model, and advanced parameter controls; identical providers/models are allowed. AI versus human configures one opponent and either human color. Switching modes preserves separate drafts in page memory.

Changing a provider clears that seat's key and configuration. Editing its key invalidates its catalog and cancels stale discovery. Loading, classified failure, empty results, missing capabilities, and expired catalogs have distinct guidance. Only advertised parameters appear, with returned bounds/options; blank controls use provider defaults.

Keys are masked by default, may be revealed for the current input, and remain separate from non-secret configuration in page memory. Refresh or page exit clears them. Setup writes nothing to browser storage, URLs, or history state. **Start game** validates every AI seat and sends [credential-free creation](game-protocol.md#ai-game-api).

An accepted start begins the selected mode. **Return to game** restores saved configuration and accepted history, then recovers paused. **Enter missing keys** identifies each AI seat/provider; **Use keys for this page** retains input without starting work. Dismissing the dialog leaves the recovery banner. Continuation requires all missing keys and an explicit action.

An access failure clears the private board. **Return to setup** checks or re-establishes the guest session without retrying the rejected game command.

## AI playback UI

Starting AI versus AI requests one turn at a time, using the current seat's page-memory key. The board is read-only and preserves its accepted position during work. Game lifecycle and model activity remain separate.

| Control            | Behavior                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Pause**          | Stops automatic progression and submits a pause, including during thinking or synchronization.                           |
| **Resume**         | Explicitly resumes active progression after a pause/recovery.                                                            |
| **Next move**      | Executes one paused AI turn; an unfinished game stays paused.                                                            |
| **Retry move**     | Available after a provider failure in either AI mode; executes one paused turn with the remaining invalid-output budget. |
| **Playback speed** | Sets the presentation gap after an accepted move: 0.5× = 2 seconds, 1× = 1 second, 2× = 0.5 seconds.                     |
| **Stop game**      | Opens confirmation; confirming records `aborted` and releases the unfinished-game slot.                                  |

Speed changes reschedule a waiting gap without changing a running provider request or its parameters. It is neither a chess clock nor a provider-latency or spending guarantee.

Stop confirmation stays open across accepted moves and pauses in the same unfinished game. Confirmation uses the latest accepted revision; opening the dialog alone leaves playback running. Cancellation, submission, completion, access loss, or changing games closes it. See the [confirmation/focus contract](design-system.md#keyboard-and-chess-interaction).

### Interrupted or uncertain work

Provider failure, terminal outcome, transport uncertainty, offline state, and page exit stop scheduling. **Check position** reads accepted state without starting work. A newer position may be adopted with progression off; an unchanged position can still have an outstanding turn.

Use **Pause** to invalidate uncertain AI work before **Resume** or **Next move**, or **Stop game** to end the match. An uncertain lifecycle command offers **Retry same command**. Recovery that has not reached a confirmed pause offers **Retry recovery**. The exact retry/fencing rules are in the [game protocol](game-protocol.md#browser-command-synchronization).

Refreshing, closing, or leaving the page clears keys, including back-forward-cache navigation. Returning requires paused recovery and re-entry. Reconnection on the same live page can retain keys but still requires explicit continuation. API restarts also recover paused. Cancellation does not promise to avoid the cost of a call already sent.

### Rejected-key correction

A rejected key shows a safe explanation and **Update key** beside the affected model in either AI mode. The masked dialog edits only that seat, discards cancelled input, and preserves the other seat and saved configuration. **Use keys for this page** applies the replacement without discovery or generation; then choose **Retry move** or **Resume**. Refresh recovery uses **Enter missing keys**.

## AI versus human UI

The board faces the selected human color and accepts moves only on that authorized active turn. Select a source and legal destination using touch, mouse, or the [board keyboard controls](design-system.md#keyboard-and-chess-interaction). A pending command preserves the accepted position and locks move input. Promotion requires an explicit queen, rook, bishop, or knight choice.

The AI replies after an accepted human move and opens immediately when the human selects Black. A rejected, conflicting, or uncertain human response does not launch AI work. Explicit human-command retry preserves the command identity; successful retry can schedule the opponent, while reconciliation alone requires explicit continuation.

**Pause**, **Resume**, **Retry move**, and confirmed **Stop game** use the shared controls. Speed and ordinary Next move belong to AI versus AI. **Resign White** or **Resign Black** appears only for the human seat, remains available off-turn or paused, and requires confirmation. It follows the latest accepted revision, names the configured human color, and invalidates a pending AI result.

## AI telemetry and replay

Both AI modes show the latest accepted AI move for each seat, commentary, latency in milliseconds, and reported input/output/total token counts. **Attempts and errors** lists recorded calls in order, including invalid responses, provider failures, and interruptions. Expand an attempt for its measurements. Follow the [counter definitions](game-protocol.md#terms-and-counters).

Pending turns update attempt history and the amber **Invalid response. Retrying (1 of 2)…** / **(2 of 2)…** labels without changing the board. Very short attempts may finish between progress reads; the final history retains recorded attempts.

Missing or empty accepted commentary displays **No commentary provided** and renders as plain text. Unreported measurements display **Unavailable**; reported zero remains zero. Per-move values belong to the accepted attempt. The [invocation projection](game-protocol.md#invocation-projection) defines measurement and privacy semantics.

Completed or stopped matches expose replay and PGN controls. Selecting a ply synchronizes the board, moves, commentary, and measurements; the initial position and human moves have explicit empty states. Attempt history remains available for the entire game. Replay/export require no provider key. Copy and download use the same canonical PGN without commentary, telemetry, or model identities. Stockfish, pricing, totals, and richer analysis follow the [roadmap](roadmap.md).

## Sandbox UI

After [local setup](development.md#local-setup), set `SANDBOX_ENABLED=true` in the local `.env` and restart the API. Open `http://localhost:5173/sandbox` and choose **Start sandbox**. Production cannot enable it. Readiness checks the database through `/ready`; creation determines sandbox availability, so a healthy API can still report a disabled sandbox. After enabling it, choose **Retry sandbox**.

One guest controls White and Black in turn. Select a source and highlighted destination, or use the shared keyboard controls. Promotion always requires a piece choice. **Flip board** changes presentation only; pieces, turn, result, and SAN history remain unchanged until an authoritative response.

Creation at `/sandbox` writes `/sandbox?game=<uuid>`. Legacy `/?game=<uuid>` links remain supported. Refresh/reopening resolves the private URL; opening `/sandbox` without an ID discovers the existing guest's unfinished sandbox. The root `/` opens AI setup. Recovery pauses active games before enabling play; **Resume** is explicit.

**Pause** and **Resume** preserve position and history. **Abort**, **Resign White**, and **Resign Black** are available while active or paused and require confirmation, initially focused on Cancel. Abortion displays **Game stopped** with result `*`; resignation awards the other color a win, including off-turn. Sandbox confirmations close when accepted position or interaction state changes.

An uncertain submission preserves the original command. **Check game status** reads its snapshot; **Retry same move** or **Retry same command** resubmits the identical payload. Same-version reads remain uncertain. Access loss clears board/replay/export state and requires **Start sandbox again**. See [synchronization and recovery](game-protocol.md#browser-command-synchronization).

Terminal games open replay at the final ply with **First**, **Previous**, **Next**, **Last**, and selectable SAN moves. **Copy PGN** and **Download PGN** use the private export endpoint; clipboard failure exposes selectable text. Download uses canonical UTF-8 text in `neurochess-<uuid>.pgn`. **New game** preserves the previous record; browser Back can reopen its private URL during the existing guest session. There is no guest history list or retention cleanup.

## Web implementation references

Visible copy and document metadata come from `apps/web/src/i18n/en.ts`. Typed i18next resources use English fallback, complete messages, and named placeholders; no browser-language detection ships. Preserve UCI, SAN, and coordinates. Map safe API codes to catalog entries; never display server messages or caught exceptions.

Presentation uses Tailwind utilities in JSX, the semantic theme/base layer in `apps/web/src/styles.css`, and shared controls under `apps/web/src/ui`. Inter and Orbitron are bundled locally. Format changed markup with Prettier's Tailwind sorting. Tests select by role, accessible name, or data attribute rather than utility class. Use the [design system](design-system.md) and [browser tests](testing.md#browser-tests) for implementation verification.
