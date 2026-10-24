# Third-party components

Neurochess Arena's original code is licensed under GPL-3.0-only. This does not
replace the licenses or copyright notices of its dependencies, fonts, or
vendored materials.

- **Stockfish.js 19.0.1 / Stockfish:** GPLv3. The exact engine source, NNUE
  network, author notices, license, hashes and build instructions are in
  [apps/web/vendor/stockfish](apps/web/vendor/stockfish/REBUILD.md).
  [Supplemental notices](apps/web/vendor/stockfish/SOURCE-NOTICES.txt) cover the
  third-party files inside the unchanged upstream source archive, including
  its example applications, Wikipedia chess-piece images and build tools.
- **Inter and Orbitron:** SIL Open Font License 1.1. Their copyright notices
  and full license texts are included in the generated web notices.
- **chess.js:** BSD-2-Clause. **React, React DOM, React Router, i18next,
  react-i18next, Zod and their bundled JavaScript dependencies:** MIT.
  Production web builds emit their installed copyright and license texts in
  `THIRD-PARTY-NOTICES.md`, linked from `licensing.html`.
- **Server and development dependencies:** their installed license files and
  notices remain authoritative. Exact versions are pinned in `package-lock.json`.
  Do not infer a redistribution license from whether npm labels a package as
  a development dependency. Any future downloadable container release needs
  an inventory of the final image, including its OS and runtime components.

The application's chess-piece silhouettes are original source assets in
`apps/web/src/board/piece-icon.tsx`. They are separate from the Wikipedia images
inside the Stockfish example archive. Design concept images are generated
references; no third-party ownership is claimed for them.

## Upstream JavaScript sources

The application build archive supplies the project's own build sources. Some npm
packages contain generated distribution files, so the lockfile alone is not an
offer of their upstream preferred sources. The following full repository archives
include the sources and build scripts for the currently bundled JavaScript
dependencies. Revisions come from the exact npm releases' `gitHead` metadata,
except React Router, whose `react-router@8.4.0` tag resolves to the listed commit.

| Bundled package versions                                                        | Upstream source archive                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| react@19.3.0, react-dom@19.3.0, scheduler@0.28.0, use-sync-external-store@1.7.0 | [React source](https://github.com/react/react/archive/1d34f91dfde6bba84d08b683aaba164c7194dacb.tar.gz)                   |
| react-router@8.4.0                                                              | [React Router source](https://github.com/remix-run/react-router/archive/7ccdcecdd944e15be0cd0dcb702b86c9af1214a8.tar.gz) |
| i18next@26.4.4                                                                  | [i18next source](https://github.com/i18next/i18next/archive/f6a7746d119790f07bc03ba86b130b090af8e443.tar.gz)             |
| react-i18next@17.0.16                                                           | [react-i18next source](https://github.com/i18next/react-i18next/archive/606b6a55f231bbf73823863fbb94e6b8eb8272fd.tar.gz) |
| zod@4.6.7                                                                       | [Zod source](https://github.com/colinhacks/zod/archive/b500a2ee95134f81d74da7911d7378dd2853d042.tar.gz)                  |
| chess.js@1.4.0                                                                  | [chess.js source](https://github.com/jhlywa/chess.js/archive/ce1ff9e9fc342984ff75ca475ab39f37888cb28a.tar.gz)            |

Keep these version mappings current when dependencies change. Release operators
must keep the corresponding upstream sources accessible while distributing the
associated binaries; preserve a mirror if an upstream archive becomes unavailable.
The stockfish engine source is supplied locally as described above. This source
inventory does not claim an independent byte-for-byte rebuild of every upstream
npm package.

The [distribution policy](docs/licensing.md) describes the source offer and
release checks. Preserve all upstream notices when copying or redistributing
the corresponding components.
