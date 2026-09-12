# Sandbox adaptation — v1

**Status:** Draft for visual review, 2026-09-12. This proposal covers the design step of the sandbox remake; it does not mark the remake implemented or replace accepted product contracts.

Sandbox uses the same arena composition as the [core journey concepts](../README.md): equal participants, a dominant board, controls beneath it, and an information rail. The [design system](../../../design-system.md) remains the authority for exact tokens, type sizes, responsive tiers, and accessibility. [Sandbox behavior](../../../product.md#development-sandbox) remains unchanged.

## Screens

| State              | Desktop                                            | Mobile                                           | Main review point                                                                    |
| ------------------ | -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Entry              | [01-entry-desktop.png](01-entry-desktop.png)       | [02-entry-mobile.png](02-entry-mobile.png)       | One explicit Start action and a read-only standard-position preview                  |
| Active             | [03-live-desktop.png](03-live-desktop.png)         | [04-live-mobile.png](04-live-mobile.png)         | Turn in the page header, direct board controls, open move-history rail               |
| Recovered / paused | [05-recovery-desktop.png](05-recovery-desktop.png) | [06-recovery-mobile.png](06-recovery-mobile.png) | Preserved position, explanation near recovery, one Resume action                     |
| Result / replay    | [07-replay-desktop.png](07-replay-desktop.png)     | [08-replay-mobile.png](08-replay-mobile.png)     | Result becomes the page heading; compact navigation and PGN actions follow the board |

Desktop compositions target approximately 1440 CSS pixels; mobile compositions target 390 CSS pixels with normal vertical scrolling. Raster dimensions are independent of CSS viewport dimensions. These are generated references, not browser screenshots or interaction-test evidence. The exact generation and refinement text is retained in [prompts.json](prompts.json); all images were produced with the built-in Image Gen tool.

## Composition and component inventory

The proposed names identify presentation responsibilities, not a new transport API or a required directory structure.

| Family            | Shared anatomy                                                       | Sandbox configuration                                                               |
| ----------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| App shell         | Wordmark, navigation, contextual access area, footer                 | Arena navigation on desktop; quiet Local development label and service readiness    |
| Game header       | Title, lifecycle/turn, privacy, optional result score                | Sandbox while playing; winner and termination reason after completion               |
| Arena layout      | Participant bar, square board region, toolbar area, information rail | Same desktop frame across states; one column on mobile                              |
| Player summary    | Color, identity, activity, optional model details                    | Two equally prominent human seats, both You · Guest                                 |
| Game toolbar      | Primary lifecycle action, orientation, secondary actions             | Pause/Resume, Flip board, Abort game, both resignation actions, keyboard disclosure |
| Game details      | Section heading, tabular details, optional supporting panels         | Moves and contextual guidance; future AI panels can occupy the same rail            |
| Recovery notice   | Cause, preserved-state explanation, associated recovery action       | In-flow notice and one Resume button; no credential form for human seats            |
| Replay and export | Cursor navigation, selected-ply label, copy/download                 | Four manual navigation controls and private PGN actions                             |

The board, move table, button, icon, disclosure, and dialog families are shared across these screens. Human seats have no AI-only fields. Commentary, evaluation, telemetry, account access, and additional detail tabs appear only when the corresponding mode and feature exist; they are not placeholders in this sandbox proposal.

## Layout decisions

- Keep the existing navy/cyan theme, display/UI/mono font roles, and one restrained chamfered frame. Section headings such as Moves and Ready when you are use the UI font. Ready, Waiting, Paused, and View board are muted; To move receives the active accent.
- Desktop places equal participant summaries over the board and move history at the top of the right rail. The dominant result or turn information belongs in the page header. Routine feedback must preserve the board, controls, and move-history geometry.
- Pause/Resume is the primary live action directly beneath the board. Flip board is a compact secondary action. Abort game is a quiet danger action; both resignation actions remain visible and retain their existing confirmations. Keyboard controls remains a disclosure.
- On mobile, the live toolbar has Pause/Resume and Flip board in its first row, Resign White and Resign Black in its second row, and Keyboard controls and Abort game in its third row. Every action retains a minimum 44px target; labels can wrap and rows can grow with text enlargement.
- Entry uses a read-only initial board, not a decorative hero or an empty move table. Desktop places Start in the right rail. Mobile places the introduction and Start before the participant bar and board preview so the initial action is immediately reachable. Previewing the entry state does not bootstrap a guest or create a game.
- Recovery preserves the live board and selected move. Desktop replaces supporting rail guidance below Moves with the recovery notice. Mobile puts the notice immediately before Resume. This is a recovery-state transition; routine submission feedback still reserves space rather than shifting controls. The board remains inspectable while paused.
- Replay uses the result and reason as the page title, with a separate score. Four compact navigation controls and the current-ply label sit below the board; Copy PGN and Download PGN follow. New game remains secondary. Changing the replay cursor changes the viewed position, not the final result or its heading.
- Preserve the canonical 1280px shell maximum, board maximum of 640px, 320–400px rail, and breakpoint rules. At 320px, retain the full 288px square board; coordinates can use square corners to avoid consuming board width. Tablet content follows the existing one-column tier.

## Proposed copy

Existing action labels continue to come from the [English catalog](../../../../apps/web/src/i18n/en.ts). New or rearranged copy stays in that localization layer when implemented. This table fixes the proposal's visible text independently of raster lettering.

| Location                       | Copy                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Shared header                  | NEUROCHESS ARENA; Arena; Local development                                                             |
| Entry title and subtitle       | Sandbox; Play both colors in one browser.                                                              |
| Entry desktop introduction     | Ready when you are; Start a standard chess game and play White and Black from this browser.            |
| Entry mobile introduction      | Start a standard chess game.                                                                           |
| Entry preview and session note | Standard starting position; Starting creates a private guest session.; Unfinished games reopen paused. |
| Active header                  | Sandbox; Black to move; Private guest game                                                             |
| Active guidance                | You control both colors.; Select a piece, then a highlighted square.                                   |
| Recovery header                | Sandbox; Game paused · Black to move                                                                   |
| Recovery notice                | Game recovered; Your position and move history were restored.; Resume when ready.                      |
| Replay header                  | Black wins by checkmate; Sandbox · Game complete · 2... Qh4#; 0–1                                      |
| Replay details                 | Ply 4 of 4; Replay keeps the final result unchanged.                                                   |
| Move history                   | Moves; Move; White; Black; 3 plies or 4 plies                                                          |
| Game footer                    | Private game · Available while your guest session lasts.; Service ready                                |
| Entry footer                   | Development only; Service ready                                                                        |

The entry session-creation note describes the anonymous entry fixture. When a guest session already exists, use context-appropriate copy such as Uses your private guest session. before starting another game. Private guest game on the preview describes the game that Start will create, not an already-created game. The result heading, turn, count, score, and availability labels are state-derived; the sample strings are not constants for every game.

## Fixtures and state constraints

Reuse the [canonical sample game and positions](../../fixtures.md#one-sample-game). Entry shows the standard position, active and recovered states show the position after `1. f3 e5 2. g4`, and replay opens after `2... Qh4#`. All four positions contain 32 pieces and White is at the bottom. In live/recovery the black queen is on d8; in final replay it is on h4, d8 is empty, and the white king on e1 is in checkmate. Moves highlights g4 during play and Qh4# at the final replay cursor.

The reference entry is a presentation preview before creation, not a persisted configuring sandbox game. The existing API starts a new sandbox as active after explicit Start. Paused recovery requires explicit Resume. Resignation and abortion keep their existing distinct outcomes and confirmations; no AI resignation, automatic replay, or additional game-creation options are introduced.

For pending, uncertain-command, access-loss, promotion, and confirmation states, retain the [existing interaction contracts](../../../design-system.md#keyboard-and-chess-interaction) and [sandbox recovery behavior](../../../architecture.md#sandbox-web-client). These states are not additional screens in this concept set. A future implementation must preserve command guards, complete accepted snapshots, keyboard focus, announcements, replay privacy, and exact PGN export.

## Review and implementation boundary

Review the common shell and frame, turn/result hierarchy, live toolbar, mobile entry order, recovery placement, and replay/export composition as one coordinated proposal. Approval would select a visual direction for the next implementation step; it would not certify runtime behavior.

Images guide composition and appearance. Use the written design-system tokens and actual font metrics rather than sampling raster shading, estimating touch targets from image pixels, or stretching a board to match a generated raster. Build the board as an exact square 8×8 grid and keep pieces as readable SVG assets; generated screenshots never become the interactive UI. Broader state, keyboard, 320px, enlarged-text, and browser verification belongs to implementation, following the existing [acceptance checklist](../../../design-system.md#accessibility-and-acceptance).
