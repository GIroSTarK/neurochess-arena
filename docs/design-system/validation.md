# Design validation limits

**Scope:** Current coverage gaps and static reference limitations, not a history of verification runs.

## Verification boundaries

- DOM semantics, focus tests and automated accessibility checks do not establish actual screen-reader speech or full accessibility conformance. Use the [physical browser release matrix](../development.md#physical-browser-release-matrix) for reader checks through authentication, setup/recovery, board/promotion, rooms, dialogs, graph/table selection, history and export.
- Bundled engines, touch emulation, keyboard scrolling and root-text enlargement do not establish branded-browser or physical Safari/iOS/Android behavior, browser/OS zoom, on-screen keyboards or native swipe/scroll chaining. These require the physical release matrix for the candidate being accepted.
- Automated keyboard acceptance uses the Ubuntu 24.04 browser baseline. The pinned Windows WebKit port skips links during native Tab traversal, so Windows runs use the [matching Linux browser server](../development.md#running-acceptance). Real Safari keyboard preferences and platform behavior require physical checks.
- The [production lab budgets](../development.md#responsive-layouts-and-performance-budgets) cover Chromium desktop/touch emulation, bundle/engine loading, sampled worker resources, 200-ply replay and injected lifecycle events. They do not establish device-wide memory use, low-memory phone behavior, OS background throttling, safe-area hardware or field-performance baselines.

The [roadmap](../roadmap.md) tracks feature delivery and release hardening. Automated Chromium, Firefox and WebKit coverage includes Sandbox, the AI modes, account journeys, and private room entry/gameplay/recovery, with account/guest combinations, either owner color, participant deletion and privacy, multiple-tab recovery, and maximum-length participant names. All three engines exercise live Stockfish evaluation, private saved replay, keyboard graph/table selection, independent room samples, cost/unavailable states and engine/upload failure recovery; Chromium and WebKit also run touch projects. Complete keyboard journeys connect sign-in, setup, credential recovery, gameplay, graph selection, history and PGN download; separate journeys cover room updates and saved-key consent/revocation. These check focus retention/return, associated announced field errors, descriptive slider values and reduced-motion status. The automated coverage boundaries above also apply to these analysis views; release acceptance status is tracked in the roadmap.

## Static reference limitations

- The [screen concepts](concepts/README.md) illustrate composition and reference states. They do not prove working gameplay, responsive behavior, accessibility, or credential security.
- Models, telemetry, costs, and evaluation samples are illustrative [fixture data](fixtures.md), not provider benchmarks or measured Stockfish results.
- Token contrast alone does not establish rendered contrast. Bundled-engine checks sample actual piece/square colors, board state and focus keylines, graph marks/text, control focus and disabled labels alongside axe and visual inspection. System color overrides and assistive display settings remain outside this coverage.

## Verification workflow

Use the [design acceptance checklist](../design-system.md#accessibility-and-acceptance), [browser test setup](../development.md#browser-tests), and [configured baseline](../development.md#root-commands). Record actual commands, results, the tested revision/environment, and retained evidence in the change summary, PR, or CI. Never include credential-bearing artifacts.

Update this document only when a coverage gap or reference limitation changes. Do not append successful-run summaries, test counts, pixel measurements, or temporary screenshot paths. Earlier dated reports remain available in this file's Git history.
