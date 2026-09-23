# Neurochess Arena design system

**Version:** 1.3

**Scope:** MVP presentation and interaction contracts; see the [roadmap](roadmap.md) for implementation status

**Last updated:** 2026-09-24

## Purpose and authority

An arena for understanding LLM chess decisions: the board is the focal point, the two competitors receive equal treatment, and commentary and measurements make their choices understandable. AI versus AI leads; AI versus human and private human games use the same system.

The direction is **refined sci-fi**: deep navy, precise cyan accents, a restrained angular frame, and readable conventional chess pieces. Use visual emphasis to communicate the next action or a change in state.

[Product behavior](product.md), [architecture](architecture.md), and the [accepted ADRs](decisions/README.md) remain authoritative for domain rules, permissions, and data flow. This guide defines presentation; concepts are not evidence of implemented features.

Use the [screen concepts](design-system/concepts/README.md) when reviewing composition and their [fixtures](design-system/fixtures.md) when checking sample copy or positions. The token values, interaction rules, and text in this guide are the implementation reference. [Validation limits](design-system/validation.md) track current coverage gaps and reference limitations.

## Foundations

### Color

Tokens are Tailwind theme variables in `apps/web/src/styles.css`. Components consume roles through utilities such as `bg-surface`, `text-text-secondary`, and `border-divider` rather than hardcoded hex values; the default Tailwind palette is disabled, so a new color must be added to the theme. Keep colors opaque when contrast depends on them; opacity on a parent also weakens text, icons, and borders.

| Role             | Theme token               | Value     | Use                                                                    |
| ---------------- | ------------------------- | --------- | ---------------------------------------------------------------------- |
| Canvas           | `--color-canvas`          | `#020914` | Page background                                                        |
| Surface          | `--color-surface`         | `#0B1626` | Information rail, forms                                                |
| Elevated surface | `--color-surface-raised`  | `#122236` | Menus, dialogs, selected neutral rows                                  |
| Primary text     | `--color-text`            | `#F3F7FB` | Headings, values, body text                                            |
| Secondary text   | `--color-text-secondary`  | `#AEBDCA` | Supporting copy and labels                                             |
| Muted text       | `--color-text-muted`      | `#8B9EB3` | Timestamps, unavailable values, secondary metadata                     |
| Primary action   | `--color-accent`          | `#3DE7EF` | Primary buttons, selected tab indicator                                |
| Text on primary  | `--color-on-accent`       | `#020914` | Text and icons on cyan fills                                           |
| Focus            | `--color-focus`           | `#3DE7EF` | Keyboard focus ring; a separate role even though it matches the accent |
| Success          | `--color-success`         | `#5EE2B2` | Confirmed completion of an action                                      |
| Warning          | `--color-warning`         | `#F2C96D` | Pause, automatic retry, recoverable interruption                       |
| Danger           | `--color-danger`          | `#FF7B8F` | Invalid fields, technical loss, destructive action                     |
| Divider          | `--color-divider`         | `#22364A` | Decorative separators and frame details                                |
| Control border   | `--color-control-border`  | `#586F86` | Necessary outlines of fields and unselected controls                   |
| Light square     | `--color-board-light`     | `#B7C7D4` | Light chess squares                                                    |
| Dark square      | `--color-board-dark`      | `#466177` | Dark chess squares                                                     |
| Light piece/mark | `--color-board-ink-light` | `#F3F7FB` | Ivory piece fill and light contrasting keyline                         |
| Dark piece/mark  | `--color-board-ink-dark`  | `#020914` | Ink piece fill and dark contrasting keyline                            |

The cyan filled button uses dark text; white text on cyan is unsuitable. Decorative dividers must not become the sole visible outline of an input. Status always combines a label with an icon or shape. White/Black labels and conventional piece appearance identify seats; provider branding never substitutes for them.

Hover and pressed states add a neutral surface or an inset contrasting keyline. Preserve the base text colors. Selected tabs combine an underline and weight change. Disabled controls retain a readable label, remove emphasis, and expose the reason nearby when it is needed to continue.

### Typography

| Role                      | Token            | Family                                                                                     |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| Wordmark and display      | `--font-display` | `"Orbitron Variable", ui-sans-serif, system-ui, sans-serif`                                |
| Interface and commentary  | `--font-ui`      | `"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` |
| Notation and measurements | `--font-mono`    | `ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace`                     |

Orbitron and Inter are bundled locally by the sandbox app. The families map to `font-display`, `font-ui`, and `font-mono`; the size tokens map to `text-caption` through `text-display` and carry their line height. Keep body copy and control labels in the UI family. The base layer sets `font-variant-numeric: tabular-nums` for changing telemetry and aligned values.

| Style / size token | Size / line height   | Weight | Application                                   |
| ------------------ | -------------------- | ------ | --------------------------------------------- |
| `--text-caption`   | `0.75rem / 1rem`     | 400    | Secondary metadata, chart labels              |
| `--text-label`     | `0.875rem / 1.25rem` | 500    | Control labels, tabs, compact metrics         |
| `--text-body`      | `1rem / 1.5rem`      | 400    | Commentary, instructions, mobile inputs       |
| `--text-wordmark`  | `1.125rem / 1.5rem`  | 600    | Arena wordmark; label size on compact phones  |
| `--text-section`   | `1.25rem / 1.75rem`  | 600    | Section heading, result detail                |
| `--text-title`     | `1.75rem / 2.25rem`  | 500    | Page title                                    |
| `--text-display`   | `2.25rem / 2.75rem`  | 500    | Large display title; use title size on mobile |

Sizes assume a 16px browser default and scale with user preferences. Reserve uppercase and up to `0.08em` tracking for the wordmark. Essential instructions never use caption size. Let long names wrap; expose complete identifiers in details if a compact row truncates them. Do not use `white-space: nowrap` on page titles.

### Spacing, geometry, icons, and motion

| Tokens                                                                    | Values                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Spacing scale `1`, `2`, `3`, `4`, `6`, `8`, `12` (`p-4`, `gap-8`, `mt-2`) | `0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `1.5rem`, `2rem`, `3rem` |
| `--radius-control`, `--radius-panel` (`rounded-control`, `rounded-panel`) | `0.375rem`, `0.625rem`                                           |
| Border width (`border`)                                                   | `1px`                                                            |
| `--spacing-target` (`min-h-target`, `size-target`)                        | `2.75rem` (44px at the reference size)                           |
| Icon size and stroke (`size-5`, `stroke-2`)                               | `1.25rem`, `2px`                                                 |
| Motion durations (`duration-120`, `duration-180`)                         | `120ms`, `180ms`                                                 |
| `--ease-arena` (`ease-arena`)                                             | `cubic-bezier(0.2, 0, 0, 1)`                                     |

Use a single chamfered arena frame as the signature motif. Buttons, forms, rows, and menus use the ordinary corner tokens. Frame geometry must not clip content, focus rings, menus, or pointer targets; apply decorative clipping to a separate non-interactive layer.

Use outline SVG icons with consistent caps, joins, optical size, and stroke. Icon-only buttons have an accessible name and a tooltip that also opens on focus, except the conventional dialog close icon, which uses an accessible name without a tooltip. Its hover and pressed background must contrast with the dialog surface. Use an existing text wordmark; a new logo and provider-logo asset collection are outside this milestone.

Use restrained shadow only for overlays; ordinary panels separate through surfaces and spacing. Keep glow outside the board and away from reading surfaces. Animate accepted moves and state changes briefly. Apply transitions and animations only through `motion-safe:` variants so `prefers-reduced-motion: reduce` removes movement and pulsing while a static activity label remains. Do not fabricate progress percentages or countdowns for provider requests.

## Layout and hierarchy

| Width        | Composition                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Above 1024px | Centered shell, maximum 1280px; 24–32px outer gutters; dominant board region beside a 320–400px information rail with a 24–32px gap. Board maximum 640px. |
| 768–1024px   | One column, 24px gutters, board centered and capped at 640px; supporting content follows it.                                                              |
| 320–767px    | One column, 16px gutters; equal-width compact player summaries, full-width square board, controls, commentary, then detail tabs.                          |

Tailwind breakpoints encode these tiers: `sm` (481px) ends the compact-phone adjustments, `md` (768px) widens the gutters, and `lg` (1025px) places the board beside the rail. The reference desktop canvas is approximately 1440px wide; mobile targets 390px. A 320px viewport leaves a 288px board with 36px squares. Keep primary controls at least 44px high; the board retains all 64 usable squares. Never hide essential actions to keep a screen within one viewport. Allow normal vertical scrolling and account for safe-area insets.

The shell contains the wordmark, Arena, and authentication/account access. Registered users also have History. Guest concepts show “Guest session” and “Sign in”. Both player summaries have equal space and always include color, provider/model or human identity, and applicable activity.

The development Sandbox has its own conditional navigation item, separate from Arena. Navigation remains visible on mobile, wrapping beneath the wordmark and context, and marks the current page with `aria-current`. Arena hosts independent AI seat setup and the live/replay views for both AI modes; it links to the development Sandbox only when enabled.

The development Sandbox uses the [selected live composition](design-system/concepts/sandbox-v1/README.md): turn/lifecycle in the page header, both participants above the board, and game controls directly below it. Service readiness sits in the footer. The live rail begins with Moves; guidance and routine feedback share a reserved text area below it. Desktop toolbar rows use three equal-width columns. The primary pair fills its columns; compact lower actions share the column starts, with equal resignation widths and equal gaps between buttons. Each button centers its icon and label. The toolbar reflows to two columns when its own width or enlarged text makes the desktop row too narrow. Keep keyboard order consistent, with orientation and inspection before the final abort action.

With further text enlargement, stack live controls in one column and allow participant icons to wrap above their identity. Preserve equal seat widths and wrap short labels between words instead of forcing narrow fragments.

On desktop, Sandbox move history fills the rail height available beside the play area after supporting content and spacing. Preserve a text-scaled minimum reading area that shows the table header and complete move rows; allow the rail and arena to grow when supporting content needs more room. Long histories scroll within the list rather than increasing the arena height. Supporting guidance, recovery messages, and New game retain their natural height below it. In the one-column layout, the move list remains bounded so later actions stay reachable.

The live information rail shows both models' latest commentary in equal blocks with a two-line preview and a compact row of per-move latency, input tokens, and output tokens. Use the section heading size for Commentary & move details. Reserve the preview, attempt, and measurement space before the first move and while details load. A labeled Read action opens the full commentary in a dialog tied to that move; continued play does not replace the text being read. Escape or Close restores trigger focus. Allow labels and measurements to reflow with enlarged text. Total tokens remain available in Events. Moves is the default detail tab, followed by Analysis for cumulative operational totals and usage breakdown, then Events for attempts and recovery events. Evaluation graphs and estimated costs extend Analysis when implemented.

On desktop, the AI rail ends with the board's primary controls (the live Delay between moves row); board inspection tools sit below that boundary. New commentary, pending measurements, tab switches, and routine pause/resume guidance keep the detail tabs in place. Show the pause status above the board; the rail's guidance explains the available next actions instead of repeating that status. Detail-tab content scrolls internally; full commentary scrolls in its dialog. Reserve scrollbar gutters and routine guidance space. Recovery actions remain reachable if they require additional scrolling. On mobile the commentary and tabs follow the board and controls in normal page flow, with bounded detail lists; enlarged text may require additional rail scrolling on desktop.

Background refresh keeps already received commentary, measurements, and events visible. New-move details stay pending until records for that move arrive, without borrowing the preceding move's explanation or usage. Analysis totals retain the history boundary of their last successful read; Analysis and Events label refreshing or failed refreshes explicitly. Leaving a game or losing access clears retained private data.

Forms use two equal seat columns on desktop and stacked White then Black sections on mobile. Keep the provider, credential, and model fields together; advanced parameters start collapsed. Overlays center on desktop and become scrollable sheets on mobile. Opening the keyboard must leave the focused field and recovery action reachable.

## Component specifications

The names below identify component families for future implementation in the web app. Presentation state and localized strings belong in the web layer; shared transport contracts remain in `packages/contracts` as required by the architecture.

### Core controls

Apply this shared state contract to each control family where relevant:

| State           | Presentation and behavior                                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default         | Persistent label, semantic border, and a clear enabled action. A placeholder is supplemental.                                                                                                                                                                   |
| Hover / pressed | Add the neutral surface or contrasting inset keyline without changing layout. Touch users retain the same actions.                                                                                                                                              |
| Focus           | Show the full 2px ring and offset; selection, focus, and validation are separate cues.                                                                                                                                                                          |
| Disabled        | Keep text readable and explain the unmet prerequisite nearby. Do not make a disabled action the only path to its explanation. Mark an unavailable action with `aria-disabled` so it stays focusable and rejects activation instead of blurring a keyboard user. |
| Loading         | Keep the label and reserved space; add a short activity message and prevent duplicate submissions. Announce completion once.                                                                                                                                    |
| Empty           | State what is absent and give a useful next action. Empty discovery, empty history, and missing commentary use different copy.                                                                                                                                  |
| Error           | Pair a safe cause with recovery, retain non-secret entered values, and associate field errors with the affected control.                                                                                                                                        |

On narrow screens, fields and menus fit the available width, primary actions may fill a row, and button labels wrap with height growing beyond the 44px minimum. Combobox results wrap long model identifiers and keep the selected value available in full. Tabs may grow to two lines; do not squeeze their labels into unreadable text. Tables retain headers, using a labeled local scroll area only when the content cannot reflow. Dialogs become scrollable sheets with actions reachable above the mobile keyboard.

Use the shared `ui/Select` for native single-value dropdowns. Its decorative arrow sits 0.75rem from the inline-end border, with matching text clearance across setup, parameters, game controls, and reference screens.

| Component          | Anatomy and variants                                                 | State and interaction requirements                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button             | Label, optional leading icon; primary, secondary, quiet, destructive | One primary action per task region. Pending keeps width and label context; prevent duplicate submission. Visible focus surrounds the full target.                                                                                                                                                 |
| Field              | Persistent label, input, optional hint, error                        | Connect hint/error through accessible descriptions. Validate on submit or completed interaction, not each initial keystroke. Never rely on placeholder text as the label.                                                                                                                         |
| Secret field       | Password input, explicit show/hide control, persistence explanation  | Mask by default and after clearing the field. Disable reveal while empty. Reveal only the value currently entered in memory. Saved credentials display masked metadata and never reveal stored plaintext. No real keys in examples.                                                               |
| Model combobox     | Search input, provider-scoped results, capability description        | Results overlay the form without moving neighboring fields and fit the available viewport. Arrow keys scroll within the list; Enter selects; Escape closes. Label loading, empty results, discovery failure, and unsupported capability distinctly. Provider/model options come from the backend. |
| Parameter controls | Capability-derived fields inside Advanced parameters disclosure      | Render only supported fields with server-provided bounds/options. Reconcile dependent fields when the model changes. Never invent a universal temperature/reasoning matrix.                                                                                                                       |
| Checkbox / radio   | Control, visible label, optional explanation                         | Space changes checkbox; radio group uses arrows. Saved-key opt-in starts unchecked and appears only for authenticated users.                                                                                                                                                                      |
| Tabs               | Label, selection underline, associated panel                         | Roving tab stop, arrows move focus, Enter/Space activates. Preserve local panel state. Avoid automatic activation when loading would be expensive.                                                                                                                                                |
| Status indicator   | Icon or shape plus text                                              | Separate identity, activity, lifecycle, and connection roles. Do not use color alone or a spinner without explanation.                                                                                                                                                                            |
| Banner             | Short cause, consequence, recovery action                            | Persistent when action is needed. Provider errors belong beside game controls; field errors stay beside fields. Announce changes once.                                                                                                                                                            |
| Dialog / sheet     | Title, explanation, content, explicit actions, dismiss control       | Move focus inside, contain it, allow Escape, and restore focus to the trigger. Destructive confirmation initially focuses the safe action. Dismissing key recovery leaves the game paused.                                                                                                        |
| Tooltip            | Brief supplemental text                                              | Available on hover and keyboard focus. Essential instructions and unavailable-state explanations must also work on touch.                                                                                                                                                                         |
| Table / list       | Header, rows, selected row, optional row action                      | Right-align comparable numbers. Use actual table semantics for tabular data. Keep unavailable distinct from zero, and skeletons distinct from empty results.                                                                                                                                      |

### Arena components

| Component            | Required presentation and behavior                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Player summary       | Explicit White/Black label, human name or provider and model, optional avatar, activity. Equal prominence and spacing for both seats, including identical-model matches. Human seats omit AI-only fields.                                                                    |
| Chessboard           | Exactly 8×8; White at bottom by default for AI observation, the human's color at bottom for play. Coordinates remain correct after a flip. Standard Staunton silhouettes with contrasting outlines. Server-accepted state is authoritative.                                  |
| Board overlays       | Selected square uses a contrasting inset frame; legal targets use dots and captures use rings; last move uses corner marks; check marks the king square plus text. Keep keyboard focus distinct using a dual light/dark keyline. Re-evaluate contrast on both square colors. |
| Evaluation indicator | Label “Stockfish evaluation”; positive numeric scores favor White, negative favor Black. Mate values name the benefiting color. Pending/unavailable remains explicit; never imply an evaluation is a win probability.                                                        |
| Playback toolbar     | Pause, Resume, Next move, selected speed, Stop where the mode permits. Next move is available while paused with required credentials ready. Explain speed as presentation pacing; it is not a chess clock or a guarantee of provider latency.                                |
| Move list            | Move number, White SAN, Black SAN, current/selected move. UCI remains the machine format. Preserve reader scroll when they inspect earlier rows. Replay selection synchronizes the displayed position, commentary, evaluation, and per-move metrics.                         |
| Commentary entry     | Color, model, associated move, concise text, optional measurements                                                                                                                                                                                                           |
| Telemetry row        | Compact per-move latency and input/output tokens when known; total tokens in Events and cumulative operational totals in Analysis. Use consistent units and tabular digits.                                                                                                  |
| Evaluation graph     | Move/ply axis, neutral baseline, selected-move marker, labeled score or mate. Keep unknown samples as gaps. Provide selected values and an accessible tabular/text equivalent. Do not draw mate as an invented numeric centipawn score.                                      |
| Event history        | Ordered attempts, safe normalized reason, and recovery/result events. “Attempt 2 of 3” and “Retry 1 of 2” describe different counts; label them explicitly. Never include raw provider payloads or credentials.                                                              |
| Result summary       | Result, winner where applicable, termination reason, totals, replay actions, PGN copy/download. Draw, technical loss, and stopped game receive their own wording. A generic red “Error” cannot replace the result.                                                           |

Commentary is viewer-facing explanation, never a transcript of hidden reasoning. Render it as untrusted text; the empty state is exactly **No commentary provided**. Keep it visually separate from Stockfish analysis. Neither commentary nor analysis changes legal move authority or enters the opponent's model prompt.

### Keyboard and chess interaction

Replay navigation keeps the selected SAN visible below the move list's sticky header without moving page scroll or keyboard focus. Returning to the initial position scrolls the list to the beginning.

Use an accessible [grid interaction pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) with one square in the page tab order. Arrows move by the board's visible orientation; square labels always announce the actual algebraic coordinate, piece/color, and applicable selection/check state. Enter or Space selects a movable piece and confirms a legal destination; Escape cancels the selection. Home/End move within a row; Ctrl+Home/End move to the first/last visual square. Keyboard navigation scrolls its destination into view; restoring focus after the promotion dialog closes preserves the scroll position. Tab leaves the board.

Support click/tap source then destination as well as optional dragging. A promotion opens a keyboard-operable choice of queen, rook, bishop, or knight; never silently force a queen. Use four labeled choices with 44px minimum targets, wrapping to a 2×2 arrangement on narrow screens or one column when enlarged text needs more room. Name the destination and color, move focus into the choice, and keep the accepted board position visible. Cancel returns to the pending selection. Pending human submissions lock further move submission, preserve the accepted position, and announce confirmation or a safe rejection. In AI observation and replay, allow inspection without enabling human moves.

Announce accepted moves, turn changes, check, and results through a concise polite live region. Do not steal focus on a move or announce every changing metric. A reconnect must restore an authorized snapshot before interaction resumes.

Routine move/lifecycle feedback preserves the status summary and feedback geometry and the positions of controls and move history. Reserve localized variants, including state markers, without fixed heights or duplicated interactive controls. Error details may expand for readability; the terminal result/replay view is a separate layout transition.

Pause and Resume preserve focus on the same control during pending and accepted commands. Unavailable actions, including lifecycle, replay navigation, PGN export, Start, and New game, remain focusable and visibly disabled through `aria-disabled`, but reject activation and a held activation key. Returning responses must not steal focus if the user has moved elsewhere. When an accepted Start or New game removes the activated control, focus lands on the board's current square; recovery on page load never moves focus. Updated game state invalidates destructive confirmations independently of control focus.

## Game state and recovery

Keep **game lifecycle**, **turn activity**, and **connection status** separate. “Thinking”, “Retrying”, and “Reconnecting” are presentation/activity descriptions, not additional canonical game states.

| Situation                                                 | Treatment                                                                       | Action / outcome                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Configuring                                               | Neutral form, clear missing-field guidance                                      | Start game only when configuration is ready. Existing active/paused game shows Return to game.        |
| Active AI turn                                            | Cyan static/pulsing activity icon and “Black is choosing a move…”               | Prevent duplicate turn requests; keep the last accepted position visible.                             |
| First or second invalid model response                    | Amber “Invalid response. Retrying (1 of 2)…” then “(2 of 2)…”                   | Automatic retries; include attempt details in Events.                                                 |
| Third invalid model response                              | Completed result with danger-accented “Technical loss” and the losing color     | No fourth automatic attempt. Replay remains available.                                                |
| User-paused AI game                                       | Amber “Game paused”                                                             | Resume; Next move when ready; Stop.                                                                   |
| Provider auth failure                                     | Paused; rejected-key explanation beside the relevant seat                       | Update key, then user-directed retry.                                                                 |
| Provider quota, timeout, network, or availability failure | Paused; a specific safe cause and preserved board                               | Retry move when the user chooses. These failures never count as a technical loss.                     |
| Refresh recovery                                          | Paused; “Re-enter your API keys” and session-only explanation                   | Enter the missing keys required for the configured AI seats, then Resume.                             |
| Human-room disconnect                                     | Connection warning; preserve position and identify the disconnected participant | Reconnect without countdown or forfeiture. Follow the server lifecycle; do not invent a timeout loss. |
| Stale/duplicate command                                   | Brief synchronization feedback                                                  | Refresh current state; never append a speculative move.                                               |
| Normal completion                                         | Neutral result panel with explicit reason                                       | Replay and PGN export; no continuation controls.                                                      |
| Stopped/owner-aborted game                                | Neutral “Game stopped”, state `aborted`                                         | Retain history for registered participants; no misleading completed/chess-loss label.                 |

While a pause/stop request is pending, show that the command is being applied and follow the returned server state. Do not promise that a provider request already in flight was canceled or that its cost was avoided.

### Credential and telemetry rules

- Session-only is the default. Label it **Use for this tab** with **Cleared when you refresh or close this tab.** Keep raw values only in page memory and the minimum backend request scope described in [ADR-0004](decisions/0004-bring-your-own-key-security.md).
- Authenticated users may explicitly select an existing saved credential or check **Save this key to my account**. Explain persistence before submission. Never preselect the save checkbox, imply guests can save, or claim a key stays only on the user's device.
- On refresh, show which seats/providers need keys. Dismissing recovery leaves a persistent banner. Preserve configuration and accepted position, but never restore raw keys from browser storage.
- Ordinary Pause keeps the available keys and shows commentary and detail tabs without a key-editing action. Missing keys replace the rail contents with the recovery card from the [recovery concept](design-system/concepts/05-recovery-desktop.png): named AI-seat fields, reveal controls, the session-only explanation, gated Resume, and Return to game. Authentication failures open the same card for the rejected seat. Keep fields visible while typing; only explicit continuation resumes play. Return to game restores details and leaves a persistent re-entry action while paused. On mobile the card replaces details below the board and controls.
- Use **Estimated cost** or **Est. cost** in compact rows. Unknown usage or pricing displays **Unavailable**, with a concise reason where available. Do not substitute zero or sum incomplete data as a complete total. Keep per-move details available even when an aggregate is unavailable.
- “Latency” is measured response duration; it is not a countdown. All provider names, model names, usernames, avatars, commentary, and error details are untrusted rendering inputs.

## Supporting MVP patterns

| Flow            | Design requirements                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI versus human | Reuse one AI configuration section plus the human color choice. Permit moves only on the authorized human turn. Human resignation uses explicit confirmation; no AI-resign control.                                                                |
| Authentication  | Email/password, Google, GitHub, verification, and password-reset forms use the same controls. Allow paste and password managers. Give actionable field-level feedback and preserve a clear return path.                                            |
| Private rooms   | Authenticated owner creates and chooses color. Invitation link/code is a join affordance, not a spectator/share-game feature. Guests may join, but room creation requires sign-in. Owner closing a room explicitly says the game will be stopped.  |
| History         | Private rows show players, mode, date, result/state, and replay access. List completed and aborted games together, newest first, with explicit state labels. Include empty/load-error states and guest guidance about the lack of durable history. |
| Credentials     | Provider, user label, masked metadata, and revoke action. No plaintext readback. Explain effects when a selected credential is revoked.                                                                                                            |
| Deletion        | Separate individual game, all history, credential revocation, and account deletion confirmations. State the actual scope and irreversibility, focus Cancel initially, and prevent duplicate submission.                                            |
| Identity        | Initials and validated provider avatars fit the same frame; allow removal of an imported avatar. Explain guest/account separation before sign-in. All authentication methods use the same username onboarding. See the product identity policies.  |

Do not add ratings, public games/spectators, clocks, chat, payments, custom model prompts, arbitrary starting positions, or background play. Guest retention and provider parameter matrices remain owned by the product/backend decisions.

## Localization and copy

Route strings through the localization layer from the first component implementation. Domain/transport code supplies codes and data, not display prose. Translate complete messages with named placeholders; format dates, numbers, and currency through locale-aware formatters. Preserve chess/provider identifiers rather than translating them.

| Suggested key                                          | English reference                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `arena.mode.aiVsAi`                                    | AI vs AI                                                                              |
| `arena.seat.white` / `arena.seat.black`                | White / Black                                                                         |
| `arena.activity.choosingMove`                          | {color} is choosing a move…                                                           |
| `arena.state.paused`                                   | Game paused                                                                           |
| `arena.recovery.title`                                 | Re-enter your API keys                                                                |
| `arena.recovery.description`                           | Your game was restored after a refresh. Session-only keys were cleared.               |
| `credentials.sessionOnly`                              | Use for this tab                                                                      |
| `credentials.sessionOnlyHint`                          | Cleared when you refresh or close this tab.                                           |
| `credentials.saveOptIn`                                | Save this key to my account                                                           |
| `models.loading`                                       | Loading models…                                                                       |
| `models.noMatches`                                     | No matching models. Try another search.                                               |
| `models.empty`                                         | No models are available for this provider.                                            |
| `models.discoveryError`                                | Models could not be loaded. Try again.                                                |
| `models.unsupported`                                   | This model does not support the required capabilities.                                |
| `arena.promotion.title`                                | Choose a piece for {color} on {square}                                                |
| `provider.authError`                                   | This key was rejected. Update it and retry.                                           |
| `provider.quotaError`                                  | The provider reported a quota or rate limit. Check your provider account, then retry. |
| `provider.timeoutError`                                | The provider took too long to respond. Your game is paused.                           |
| `provider.unavailableError`                            | The provider is unavailable. Your game is paused.                                     |
| `arena.retry.invalidResponse`                          | Invalid response. Retrying ({retry} of 2)…                                            |
| `arena.result.technicalLoss`                           | {color} loses: three invalid responses.                                               |
| `arena.commentary.title` / `arena.commentary.missing`  | Commentary / No commentary provided                                                   |
| `arena.analysis.title`                                 | Stockfish evaluation                                                                  |
| `telemetry.estimatedCost` / `telemetry.unavailable`    | Estimated cost / Unavailable                                                          |
| `arena.controls.pause` / `arena.controls.resume`       | Pause / Resume                                                                        |
| `arena.controls.nextMove` / `arena.controls.retryMove` | Next move / Retry move                                                                |
| `arena.controls.stop`                                  | Stop                                                                                  |
| `arena.singleGameConflict`                             | You already have a game in progress.                                                  |
| `arena.singleGameAction`                               | Return to game                                                                        |

Copy should identify the condition and the useful next action. Avoid technical error dumps, claims of model understanding, or promises about provider response time. Allow at least 50% text expansion in review fixtures and complete wrap for long model identifiers.

## Screen reference contract

| Screen   | Default composition                                                                                                        | Mobile adaptation                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Setup    | Title, mode choice, equal White/Black configuration, session-only explanation, advanced parameters collapsed, Start game   | Seats stack in the same order; fields remain labeled and full width                                 |
| Live     | Board and player summaries, evaluation and toolbar; both latest commentary entries, compact metrics; Moves selected        | Board precedes controls, then commentary and detail tabs                                            |
| Recovery | Same accepted position and player identities; key re-entry card replaces details, Resume gated on missing inputs           | Recovery card replaces details below the board, with required provider fields and reachable actions |
| Replay   | Result and reason, board and move navigation; synchronized commentary, Analysis selected, graph, totals, copy/download PGN | Summary, board/navigation, analysis, metrics, and export actions remain reachable in normal flow    |

The eight concepts share the same palette, typography, frame, controls, and sample game. Reference images contain fictional model labels and explicitly illustrative telemetry. They are not provider performance claims or live provider output.

## Accessibility and acceptance

Target WCAG 2.2 AA. Normal text requires at least [4.5:1 contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html); essential graphical/control indicators require [3:1 against adjacent colors](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). The design target is 44px primary controls; the standard's [minimum target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) also governs dense board/table interactions.

Use a visible 2px focus ring with a 3px offset against dark surfaces. On board squares, use contrasting inner/outer keylines. Never clip or cover focus. Provide semantic landmarks and headings, labeled fields, accessible error associations, chart alternatives, and polite state announcements. No essential information depends solely on color, animation, dragging, hovering, or icons.

Review the following before accepting an implementation:

1. At 320, 390, 768, 1024, and 1440px, keep the full board and every primary action reachable without horizontal page scrolling. Check 200% text enlargement, mobile keyboards, long names, and translated-text expansion.
2. Operate setup, tabs, dialogs, board selection, castling, en passant, promotion/underpromotion, replay, and export by keyboard. Check focus return and reduced motion.
3. Distinguish all three attempts, provider pauses, refresh key loss, missing commentary/metrics, stale commands, human disconnects, checkmate, draws, technical loss, and aborted games.
4. Confirm identical-model matches remain distinguishable, both colors receive equal space, and a guest cannot see saved-key or room-creation controls as available actions.
5. Compare each rendered screen to its concept for copy, hierarchy, typography, tokens, geometry, and board position. Validate legal positions independently; visual appeal cannot excuse a wrong square or piece.
6. Run the configured formatting, lint, typecheck, test, and build baseline. Add behavior tests when components are implemented; static concept images do not establish runtime accessibility or game correctness.

Record change-specific verification results in the change summary, PR, or CI. Update [validation limits](design-system/validation.md) only when a coverage gap or reference limitation changes; do not append run logs. Apply this guide to each delivered flow and track milestone completion only in the [roadmap](roadmap.md).
