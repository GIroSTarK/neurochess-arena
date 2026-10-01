# Design validation limits

**Scope:** Current coverage gaps and static reference limitations, not a history of verification runs.

## Open verification gaps

- Actual screen-reader speech with NVDA, JAWS, VoiceOver, or Narrator remains unverified. DOM semantics, focus tests, and automated accessibility checks do not establish full accessibility conformance.
- Firefox, WebKit, physical touch devices, browser/operating-system zoom, and on-screen keyboards remain unverified. Chromium touch emulation and root-text enlargement are not substitutes for those checks.
- The production build splits vendor code into separate chunks, but no bundle size budget or field-performance baseline has been established.

The [roadmap](../roadmap.md) tracks feature delivery and release hardening. Automated browser coverage includes Sandbox, the AI modes and account journeys. Private rooms and Stockfish analysis still need their own acceptance coverage when implemented.

## Static reference limitations

- The [screen concepts](concepts/README.md) illustrate composition and reference states. They do not prove working gameplay, responsive behavior, accessibility, or credential security.
- Models, telemetry, costs, and evaluation samples are illustrative [fixture data](fixtures.md), not provider benchmarks or measured Stockfish results.
- Token contrast alone does not establish contrast for every rendered piece, component, focus ring, overlay, or disabled control.

## Verification workflow

Use the [design acceptance checklist](../design-system.md#accessibility-and-acceptance), [browser test setup](../development.md#browser-tests), and [configured baseline](../development.md#root-commands). Record actual commands, results, the tested revision/environment, and retained evidence in the change summary, PR, or CI. Never include credential-bearing artifacts.

Update this document only when a coverage gap or reference limitation changes. Do not append successful-run summaries, test counts, pixel measurements, or temporary screenshot paths. Earlier dated reports remain available in this file's Git history.
