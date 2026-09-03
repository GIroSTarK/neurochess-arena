# ADR-0008: Tailwind CSS utilities for web presentation

**Status:** Accepted  
**Date:** 2026-09-03

## Context

The web app styled the sandbox with one hand-written stylesheet: design tokens as `--nc-*` custom properties, BEM-style component classes, and media queries. Every new component required naming classes, keeping selectors in sync with markup, and re-deriving responsive and state rules by hand. The [design system](../design-system.md) defines a fixed semantic palette, type scale, geometry, and motion contract, and forbids hardcoded colors in components. Upcoming milestones add configuration forms, tabs, telemetry tables, and dialogs, which multiplies that maintenance cost.

## Decision

- Use Tailwind CSS v4 through `@tailwindcss/vite`. Styling lives in JSX as utilities; the only stylesheet is `apps/web/src/styles.css`.
- Define the design-system tokens in that stylesheet's `@theme` block. The default Tailwind palette, type scale, and breakpoints are disabled so components can only use semantic roles (`bg-surface`, `text-text-secondary`, `text-label`, `rounded-control`). Spacing stays on Tailwind's 0.25rem scale, which already matches the documented spacing tokens.
- Keep a small `@layer base` for document-level rules that markup cannot express: root colors, tabular numerals, pointer cursors, wrapping, and the shared focus ring.
- Register `@utility` classes only for irreducible visual primitives (the chamfered arena frame, the checkered entry backdrop, the last-move corner marks). Do not add component classes.
- Share repeated utility strings through small presentation components and constants under `apps/web/src/ui`. Gate every transition and animation behind `motion-safe:`.
- Sort utilities with `prettier-plugin-tailwindcss`. Tests and browser checks select elements by role, accessible name, or data attribute, never by utility class.

## Consequences

- Component presentation is visible beside its markup, and responsive or state variants use one vocabulary (`max-sm:`, `lg:`, `aria-disabled:`, `data-turn:`).
- Token names changed from `--nc-color-*` to Tailwind namespaces such as `--color-*`; the design system documents the new names and the corresponding utilities.
- Class strings are long for dense components such as board squares; the shared constants and Prettier sorting keep them reviewable.
- Reduced-motion handling is no longer a global override, so authors must remember `motion-safe:` on new motion.
- Adding a color or size outside the theme requires editing the theme, which is intentional.

## Alternatives considered

- **Keep the hand-written stylesheet.** Lowest immediate cost, but selector drift and duplicated responsive rules grow with each flow.
- **CSS Modules or vanilla-extract.** Scoped classes remove naming collisions but keep the split between markup and styling and add build tooling without a shared design vocabulary.
- **Tailwind with the default palette enabled.** Rejected because the design system requires semantic roles and equal treatment of both seats; an open palette invites one-off colors.
