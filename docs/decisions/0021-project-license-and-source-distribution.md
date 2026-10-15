# ADR-0021: Project license and source distribution

**Status:** Accepted

**Date:** 2026-10-15

## Context

The owner intends to publish Neurochess Arena's source on GitHub and operate a
public website. The repository previously had no selected license, and
[ADR-0019](0019-browser-analysis-and-private-samples.md#distribution-and-licensing)
left public engine distribution gated on that decision and a compatibility review.
The browser downloads Stockfish.js JS/WASM under GPLv3. A worker boundary alone
does not determine whether an integration is a separate or combined work.

## Decision

The owner selects **GPL-3.0-only** for original project code, configuration and
documentation, with the copyright notice **2026 Illya Katynskyi**. Root and
workspace package metadata use that SPDX identifier. Third-party materials retain
their own terms and notices; the repository license does not relicense them.

Distribute the application under GPLv3 without relying on an exception for the
Stockfish worker boundary. The bundled application JavaScript uses MIT/BSD-2-Clause
dependencies; preserve their notices with the GPL distribution. Inter and Orbitron
remain separate OFL-1.1 font assets. The unchanged Stockfish source archive includes
additional MIT, BSD, Apache-2.0 and CC BY-SA example/build materials; preserve their
supplemental notices and the image license separately. Development-tool licenses
do not automatically become licenses for their generated output. This is a
technical compatibility assessment of these materials, not an independent legal
opinion or an ownership audit.

Every production web build includes its application build sources, full GPL text,
bundled dependency/font notices and the existing exact engine source/network/build
materials. Provide a visible source/license link and anonymous downloads. The
[licensing policy](../licensing.md) owns release, rebuild and source-retention
instructions. Public URL verification remains a deployment acceptance check.

This resolves ADR-0019's open license selection without changing its engine,
privacy or analysis contracts. Future container/binary publication requires a
review of those artifacts; it is outside the current GitHub-plus-website scope.

## Consequences

Commercial use and redistribution are permitted under GPLv3. Distributed
derivatives must meet its source and licensing requirements. GPLv3 does not add
AGPL's source-offer requirement for modified server programs used only over a
network. Already granted rights in distributed copies cannot simply be withdrawn.

## Alternatives considered

- **MIT / Apache-2.0:** permissive options for original code, but they do not remove
  Stockfish's GPL obligations. The owner chose a uniform GPL distribution policy.
- **AGPLv3:** adds obligations for modified hosted versions; the owner selected GPLv3.
- **No license:** does not grant the public the intended reuse and modification rights.

References: [Stockfish GPL guidance](https://stockfishchess.org/about/#about-the-gpl),
[GNU compatibility guidance](https://www.gnu.org/licenses/license-compatibility.en.html),
[SIL OFL](https://openfontlicense.org/open-font-license-official-text/).
