# Design-system validation

**Scope:** Static reference limitations and implementation checks

## Limitations

- The [eight screen concepts](concepts/README.md) are static browser captures. They illustrate composition and reference states; they do not prove working gameplay, responsive behavior, accessibility, or credential security.
- Models, telemetry, costs, and evaluation samples are illustrative [fixture data](fixtures.md). They are not provider benchmarks or measured Stockfish results.
- Reference fonts and chess glyphs need verification in the production UI. Token contrast alone does not establish contrast for rendered pieces, focus rings, overlays, or disabled controls.

## Before accepting implementation

1. Apply the [design guide's acceptance checklist](../design-system.md#accessibility-and-acceptance) to rendered components, including narrow screens, enlarged text, keyboard and assistive-technology use, reduced motion, and the [edge-case fixtures](fixtures.md#review-only-edge-cases).
2. Add behavior tests for chess interaction, retry and recovery states, credential handling, privacy, and authorized reconnection as the corresponding features are implemented.
3. Run `npm run verify` using the [development guide](../development.md#root-commands). Record actual results and unresolved issues in the change or pull request.
