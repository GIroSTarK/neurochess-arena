# Design validation limits

**Scope:** Current coverage gaps and static reference limitations, not a history of verification runs.

## Open verification gaps

- Actual screen-reader speech with NVDA, JAWS, VoiceOver, or Narrator remains unverified. P5-15 must record the available reader, OS/browser versions and observed speech through authentication, setup/recovery, board/promotion, rooms, dialogs, graph/table selection, history and export. DOM semantics, focus tests, and automated accessibility checks do not establish full accessibility conformance.
- Firefox, WebKit, physical touch devices, browser/operating-system zoom, and on-screen keyboards remain unverified. Chromium touch emulation and root-text enlargement are not substitutes for those checks.
- Physical-device performance, OS background throttling, safe-area hardware and field-performance baselines remain unverified. The [production lab budgets](../development.md#responsive-layouts-and-performance-budgets) cover Chromium desktop/touch emulation, bundle/engine loading, sampled worker resources, 200-ply replay and injected lifecycle events; these do not establish device-wide memory use or low-memory phone behavior.

The [roadmap](../roadmap.md) tracks feature delivery and release hardening. Automated browser coverage includes Sandbox, the AI modes, account journeys, and private room entry/gameplay/recovery, with account/guest combinations, either owner color, participant deletion and privacy, multiple-tab recovery, and maximum-length participant names. Chromium also exercises live Stockfish evaluation, private saved replay, keyboard graph/table selection, independent room samples, and engine/upload failure recovery. Complete keyboard journeys connect sign-in, setup, credential recovery, gameplay, graph selection, history and PGN download; separate journeys cover room updates and saved-key consent/revocation. These check focus retention/return, associated announced field errors, descriptive slider values and reduced-motion status. The manual and cross-browser gaps above still apply to these analysis views.

## Static reference limitations

- The [screen concepts](concepts/README.md) illustrate composition and reference states. They do not prove working gameplay, responsive behavior, accessibility, or credential security.
- Models, telemetry, costs, and evaluation samples are illustrative [fixture data](fixtures.md), not provider benchmarks or measured Stockfish results.
- Token contrast alone does not establish rendered contrast. Chromium checks now sample actual piece/square colors, board state and focus keylines, graph marks/text, control focus and disabled labels alongside axe and visual inspection. Other browser engines, system color overrides and assistive display settings remain outside this coverage.

## Verification workflow

Use the [design acceptance checklist](../design-system.md#accessibility-and-acceptance), [browser test setup](../development.md#browser-tests), and [configured baseline](../development.md#root-commands). Record actual commands, results, the tested revision/environment, and retained evidence in the change summary, PR, or CI. Never include credential-bearing artifacts.

Update this document only when a coverage gap or reference limitation changes. Do not append successful-run summaries, test counts, pixel measurements, or temporary screenshot paths. Earlier dated reports remain available in this file's Git history.
