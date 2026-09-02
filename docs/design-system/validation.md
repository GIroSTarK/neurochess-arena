# Design-system validation

**Scope:** Completed Phase 1 development sandbox and static reference limitations

## PR 4 validation — 2026-09-03

Validated on Windows with Node 24.19.0, npm 11.17.0, and Playwright 1.62.1 Chromium against the actual Fastify API and disposable PostgreSQL database. In-app Browser was available and used for visual and interaction checks at 1440×1080 and 390×844. The repository's requested desktop/mobile Playwright suite supplies repeatable end-to-end coverage. The PR 3 entries below are historical; PR 4 supersedes their recovery, lifecycle, replay, and export exclusions.

| Check                       | Actual result                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`            | Passed formatting, lint, typecheck, 479 unit tests across 21 files, 69 PostgreSQL integration tests across three files, all nine negative architecture fixtures, and the production build.                                                                                                                                                              |
| `npm run db:check`          | Passed migration metadata checks. Integration tests applied the migration history and verified move-receipt backfill against a populated prior schema, uniqueness, cascade, and rollback.                                                                                                                                                               |
| `npm run test:e2e`          | All 18 desktop/mobile tests passed, including the complete private game flow, both resignation colors, abortion, and isolated-guest denial.                                                                                                                                                                                                             |
| Recovery and command safety | Verified explicit Resume after refresh/reopening, repeated recovery without another pause write, duplicate mounts, identical retries after lost responses, bounded conflict recovery, and obsolete-response rejection. Restoring between knight cycles finishes repetition at ply eight; restoring at half-move 99 finishes the fifty-move draw at 100. |
| Replay and export           | Checked every Fool's Mate replay ply against persisted FEN, SAN, and UCI, including check and last-move markers. Integration coverage also includes resignation, draws, empty abortion, castling, en passant, and promotion. Replay/export leave game rows, moves, and revisions unchanged and reject unfinished or inaccessible games.                 |
| Clipboard and download      | Copy passes canonical PGN unchanged to the clipboard API. Readback accounts for Windows LF-to-CRLF conversion. The UTF-8 download exactly matches persisted PGN and has a UUID-based filename. Unit coverage verifies selectable-text fallback when clipboard access is denied.                                                                         |
| Accessibility and layout    | Desktop/mobile tests pass keyboard board inspection, focus visibility, Cancel-first confirmation dialogs, Escape/Tab containment and focus return, 44px controls, reduced motion, stable move history, narrow layouts, enlarged/expanded text, and axe checks.                                                                                          |
| Rendered evidence           | In-app Browser confirmed page identity, meaningful content, no framework overlay, and no console warnings/errors. Visual captures show the final result, SAN selection, replay controls, and private export on desktop and in a reachable mobile column.                                                                                                |

The tested flow is **Start sandbox → f3/e5 → refresh → paused recovery → Resume → g4/Qh4# → First/Previous/Next/Last and SAN selection → Copy/Download PGN → New game → browser Back to the previous private URL**. Abort displays **Game stopped** with no winner; resignation displays the opposite color's win. No provider adapters or realtime rooms participate in this flow.

In-app screenshots `neurochess-pr4-replay-desktop.png` and `neurochess-pr4-replay-mobile.png` are stored in the OS temporary directory. Playwright evidence remains under `neurochess-playwright-results` there. No credential-bearing traces, HARs, or videos were recorded. The sandbox retains the existing navy/cyan shell and board-first layout; lifecycle controls, confirmations, replay, and export use its existing tokens and semantic controls.

Actual screen-reader speech, Firefox, WebKit, physical devices, and operating-system zoom remain untested. Vite still emits its non-failing large-chunk warning (approximately 586 kB minified / 174 kB gzip); this validation establishes no field-performance claim. AI/provider states, authentication, and realtime rooms remain in later phases.

## PR 3 validation — 2026-09-02

Validated on Windows with Node 24.19.0, npm 11.17.0, and Playwright 1.62.1 Chromium. Browser tests use desktop and Pixel 7 mobile-touch emulation against real Fastify services and the guarded, disposable PostgreSQL test database. See the [development guide](../development.md#browser-tests) for setup, isolated ports, and cleanup.

| Check                          | Actual result                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`               | Passed formatting, lint, typecheck, 464 unit tests, 49 database integration tests, architecture checks (including all nine negative fixtures), and the production build.                                                                                |
| `npm run test:e2e`             | All eight desktop/mobile tests passed. Both profiles completed Fool's Mate, read the persisted result, started a new game, promoted both colors through legal moves from the standard position, and reopened an unchanged active game after reload.     |
| `npm run smoke`                | Built API and web preview passed startup checks.                                                                                                                                                                                                        |
| Automated accessibility        | No axe violations for the initial active board, promotion dialog, and enlarged/expanded-text states, using WCAG A/AA tags through 2.2.                                                                                                                  |
| Keyboard and modal interaction | Both orientations, roving focus, arrows, row/corner navigation, Escape, and Tab order passed. Native promotion trapped focus, supported cancellation with destination focus return, and required an explicit piece choice.                              |
| Responsive layout              | Inspected captures at 320, 390, 768, 1024, and 1440px. Bounds checks found no horizontal page overflow; player summaries have equal widths, the board stays square and at most 640px, and primary controls remain reachable.                            |
| Enlarged/localized text        | At 320px, 200% text and a test-only translation with at least 50% expansion remained readable in a single scrolling column. Controls wrap, with no hidden action or horizontal page overflow.                                                           |
| Focus, contrast, and motion    | Inspected outlined pieces, board coordinates, last-move corner marks, the check badge, and promotion focus keylines. The decorative frame does not clip focus. Primary controls meet the 44px target; reduced-motion styles remove control transitions. |

The 100 web unit/component tests cover localized metadata, configuration errors and announcements, duplicate-command guards, accepted-state preservation, conflict replacement, rejection synchronization, uncertain outcomes with identical-command retry, stale responses, session loss, disabled sandbox, and malformed payloads. Board coverage includes all four promotion suffixes for each color, castling, en passant, cancellation, and paused/terminal inspection. These fixtures use the public deterministic chess interface and do not expose arbitrary starting positions in the application.

### Keyboard focus visibility follow-up — 2026-09-02

Keyboard navigation now scrolls its destination into view; promotion-dialog focus restoration preserves the scroll position. The added browser regression passed on desktop at 1280×600 and mobile-touch at 390×400, covering both orientations, corner jumps, Home/End, and vertical arrow traversal. Its bounds assertion permits at most one CSS pixel of native scroll rounding. The existing eight browser cases also passed after the focus change, including promotion cancellation and underpromotion.

`npm run verify` passed the formatting, lint, typecheck, 464 unit tests, 49 integration tests, architecture checks, and production build. An in-app browser check at both viewport sizes confirmed that clicking h1 and pressing Ctrl+Home brings a8 fully into view, with no console warnings or errors. The existing bundle-size warning and cross-browser limitations below still apply.

### Move history stability follow-up — 2026-09-02

Holding a real move response reproduced a 90px downward shift of the Moves section during submission, followed by its return after acceptance, on desktop and mobile. Active games now reserve space for activity feedback; overlapping localized message variants determine the height naturally, and inactive feedback is hidden visually and from assistive technology.

The regression covers `e2e4`, `e7e5`, and `g1f3`, including empty and populated history, at 1440×1080 and 390×844. It also passes with 200% text and longer activity translations. The Moves section shifts by less than one CSS pixel during submission and after acceptance; pending moves remain absent from history, and only current activity feedback is exposed. All 14 browser tests passed, including the existing gameplay, focus, promotion, reflow, and accessibility checks.

`npm run verify` passed formatting, lint, typecheck, 464 unit tests, 49 integration tests, architecture checks, and the production build. A final in-app browser check at 1280×720 and 390×844 confirmed accepted moves, unchanged history coordinates, no horizontal overflow, and no console warnings/errors. The existing bundle-size warning and cross-browser limitations below still apply.

### Comparison with the live concepts

The [desktop and mobile live references](concepts/README.md) informed the navy/cyan palette, local Orbitron/Inter typography, equal player summaries, outlined Staunton pieces, and board-first hierarchy. Above 1024px the board and information rail share one decorative angular frame within the 1280px shell. At and below 1024px the rail follows the board in normal document order; mobile retains 16px gutters and omits the decorative frame.

The sandbox labels both seats as the guest and provides status and SAN history in the rail. AI commentary, evaluation, telemetry, account controls, and replay belong to later roadmap slices. The rendered board follows accepted server FEN, so its position intentionally differs from the illustrative concept fixture. Reload reopens through an explicit creation conflict without changing the stored lifecycle.

Each browser run writes `layout-*.png`, `text-200-percent.png`, `expanded-translation.png`, `promotion.png`, and `checkmate.png` under the operating system's temporary `neurochess-playwright-results` directory. The captures were visually reviewed. Traces, HAR files, and video are disabled to avoid recording guest credentials. An additional in-app browser check confirmed rendering, explicit reopening, flipped keyboard navigation, and no unexpected console warnings/errors.

### Remaining limitations

- Screen-reader-facing names, roles, grid structure, modal focus, and the single polite atomic live region were reviewed through DOM inspection and interaction tests. Actual speech with NVDA, JAWS, VoiceOver, or Narrator has not been reviewed; automated checks do not establish full accessibility conformance.
- Firefox, WebKit, physical touch devices, operating-system zoom, and on-screen keyboards have not been tested. The enlargement fixture changes root text size; it is not a substitute for browser/OS zoom review.
- Vite reports a non-failing bundle-size warning: the initial JavaScript chunk is approximately 568 kB minified / 169 kB gzip. No performance budget or field performance claim is established by this slice.
- Paused refresh recovery, resume/abort commands, replay/export, AI/provider states, authentication, and realtime rooms remain outside this checkpoint. Their interaction and accessibility checks remain due when implemented.

## Static reference limitations

- The [eight screen concepts](concepts/README.md) are static browser captures. They illustrate composition and reference states; they do not prove working gameplay, responsive behavior, accessibility, or credential security.
- Models, telemetry, costs, and evaluation samples are illustrative [fixture data](fixtures.md). They are not provider benchmarks or measured Stockfish results.
- PR 3 bundles local fonts and replaces reference glyphs with SVG pieces. Token contrast alone does not establish contrast for all future components, focus rings, overlays, or disabled controls.

## Subsequent implementation checks

1. Apply the [design guide's acceptance checklist](../design-system.md#accessibility-and-acceptance) to rendered components, including narrow screens, enlarged text, keyboard and assistive-technology use, reduced motion, and the [edge-case fixtures](fixtures.md#review-only-edge-cases).
2. Add behavior tests for chess interaction, retry and recovery states, credential handling, privacy, and authorized reconnection as the corresponding features are implemented.
3. Run `npm run verify` using the [development guide](../development.md#root-commands). Record actual results and unresolved issues in the change or pull request.
