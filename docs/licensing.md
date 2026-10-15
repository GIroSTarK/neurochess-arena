# Licensing and source distribution

Copyright (C) 2026 Illya Katynskyi.

Neurochess Arena's original code, configuration and documentation are licensed
under the GNU General Public License, **version 3 only** (`GPL-3.0-only`), as
selected in [ADR-0021](decisions/0021-project-license-and-source-distribution.md).
The complete terms are in [LICENSE](../LICENSE). You may redistribute and modify
the program under those terms. It is supplied without any warranty, including
merchantability or fitness for a particular purpose.

Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). This grant applies only to
rights held by the project authors. Generated reference images do not imply
exclusive rights in AI-generated output or third-party names and marks.

## Website source offer

`npm run build` packages `licensing.html`, `LICENSE.txt`, dependency notices and
`neurochess-arena-source.tar.gz` with the web output. Every application footer
links to the license page. Source is available without authentication or payment.
The archive contains the application source and configuration used for that build,
the npm lockfile, workspace manifests and the supplied Stockfish build inputs.
Local environments, installed dependencies, generated output, private operations
configuration and test fixtures are excluded. The full development repository,
including tests and design references, is linked separately.

To build from the downloaded archive, extract it into an empty directory and use
Node.js 24.5 or newer within major 24, npm 11 and `tar` on PATH (provided by current
Windows installations and the deployment build image):

```text
npm ci
npm run build
```

Set `VITE_API_BASE_URL` to the intended API origin when rebuilding the browser
application. Environment values and credentials are not part of the source offer.
The archive includes `.env.example` with development placeholders; see the
[development guide](development.md) for runtime setup. Dependency packages are
retrieved at the exact versions/integrities in the lockfile. The pinned
[upstream source archives](../THIRD_PARTY_NOTICES.md#upstream-javascript-sources)
provide the bundled JavaScript dependencies' source repositories and build scripts
separately from their generated npm packages. A successful application rebuild
does not independently verify reproduction of those upstream packages. The standalone
[Stockfish rebuild instructions](../apps/web/vendor/stockfish/REBUILD.md) cover
rebuilding the engine rather than using its verified npm binaries.

Serving JavaScript and WASM to browsers distributes copies. The source offer
therefore applies even when no downloadable app or Docker image is published.
GPLv3 section 6(d) permits a corresponding-source download alongside the object
code; this project uses that route, not a written offer on request.
[GPLv3](https://www.gnu.org/licenses/gpl-3.0.html#section6).

## Release procedure

1. Publish the licensed source revision on GitHub. Review added/copied code and
   assets for provenance and preserve their licenses. Use the same GPL-3.0-only
   terms for contributions to the original project code.
2. Build from the intended source tree. Keep the source archive, engine materials
   and notices together with each release's web artifacts and rollback image.
   Rebuild after any source change; do not combine one build's sources with
   another build's JavaScript. Retain source access for every version still
   distributed, including retained assets and downloadable releases.
3. On the public origin, follow **Licenses and source** and verify that the license,
   source archive, bundled dependency/font notices and Stockfish materials download
   correctly without a login. Verify the pinned upstream source links and version
   mappings too; maintain a mirror if an upstream archive is unavailable.
   Confirm source is the deployed build's source and
   not an SPA fallback document. Keep these checks in the release acceptance process.
4. Reassess new dependencies and assets. Stockfish's GPL, the fonts' OFL and the
   example images' CC BY-SA terms remain in force. Package metadata and security
   vulnerability audits do not replace a license review.

The current distribution scope is the public GitHub source and a hosted website.
Publishing API/web container images or other binaries adds review of the actual
distributed image contents, including OS/runtime notices and source obligations.
Operating the API privately on a server does not itself distribute that server
program; GPLv3 has no AGPL-style requirement to publish server-only modifications.
[GNU FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#UnreleasedMods).
