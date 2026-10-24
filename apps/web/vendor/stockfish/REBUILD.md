# Stockfish 19 lite single-threaded distribution

This directory supplies the exact corresponding source and network for the unmodified
`stockfish@19.0.1` lite single-threaded JS/WASM pair. The Vite plugin verifies hashes
and the module's memory declaration before emitting or serving these assets. It
copies only the selected pair from npm; this package version has no install script.
The application loads the self-hosted worker on demand.

`manifest.json` records the npm integrity, source revision, build inputs, hashes,
options and limits. `stockfish-source.tar.gz` is the unmodified archive of release
commit `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`, including the upstream build scripts.
Rebuilding that commit verifies its correspondence to the npm bytes.
The separately supplied NNUE file is embedded byte-for-byte in the WASM. Keep these
materials available for as long as this engine version is distributed.

## Reproduce and compare

Use Linux and the pinned Emscripten 6.0.9 container below. Run from this directory
with Docker. First download the Terser 5.51.2 build dependency and its transitive
dependencies using the supplied `build-package-lock.json`; they are independent
of the application's npm dependencies. The subsequent engine build runs offline.
The writable output directory must be empty. No modifications to engine sources
or options are required. The supplied `source-year.cjs` preload fixes the upstream
copyright-header year at 2026 so rebuilding in later years preserves the JS bytes.

```sh
mkdir -p rebuilt
docker run --rm \
  --mount "type=bind,source=$PWD,target=/inputs,readonly" \
  --mount "type=bind,source=$PWD/rebuilt,target=/output" \
  emscripten/emsdk@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc \
  sh -c 'mkdir /build && tar -xzf /inputs/stockfish-source.tar.gz -C /build --strip-components=1 && cp /inputs/build-package-lock.json /build/package-lock.json && cd /build && npm ci --ignore-scripts --no-audit --no-fund && tar -czf /output/build-tools.tar.gz node_modules'
docker run --rm --network none --cpus 4 \
  --mount "type=bind,source=$PWD,target=/inputs,readonly" \
  --mount "type=bind,source=$PWD/rebuilt,target=/output" \
  emscripten/emsdk@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc \
  sh -c 'mkdir /build && tar -xzf /inputs/stockfish-source.tar.gz -C /build --strip-components=1 && tar -xzf /output/build-tools.tar.gz -C /build && cp /inputs/nn-61e7af4bb97d.nnue /build/src/ && cd /build && node --require /inputs/source-year.cjs build.js --lite --single-threaded --no-split --strict-em-check && cp src/stockfish-19-lite-single.js src/stockfish-19-lite-single.wasm /output/'
sha256sum rebuilt/stockfish-19-lite-single.js rebuilt/stockfish-19-lite-single.wasm
```

Both hashes must equal the manifest's engine hashes. The pinned compiler uses
SIMD, Asyncify, a 4 MiB main stack, no Pthreads, no Syzygy, memory growth,
128 MiB initial memory and a 2 GiB maximum. Hash=16 MiB is a search option, not total worker memory. Browser
and JavaScript overhead are additional. Build configuration is in the archive's
`src/emscripten/wasm-makefile.mk`; the build entry point is `build.js`.

## Notices and release gate

Stockfish.js: copyright 2026 Chess.com, LLC; Nathan Rugg and contributors.
Stockfish: Tord Romstad, Marco Costalba, Joona Kiiski, Gary Linscott and the
contributors listed in `AUTHORS` and `Top CPU Contributors.txt`.
The embedded lite network is by Chris Bao (sscg13).
The unmodified loader retains its upstream notices. See `Copying.txt` for GPLv3.
`SOURCE-NOTICES.txt` supplements the unchanged source archive with the licenses
and attribution for its upstream example dependencies, artwork and build tools.
The current immutable profile is `sf19-lite-single-v2`, rank 2. The previous
`sf19-lite-single-v1` manifest is archived in the repository's `profiles/` directory; its saved samples remain
readable until replaced by current-profile analysis. Keep the corresponding
source materials with every older release that remains distributed.

Neurochess Arena's original code is licensed under GPL-3.0-only, selected in
ADR-0021. The engine and its third-party materials retain their existing terms.
Before public distribution, verify that this directory's license, exact source,
network and notices remain publicly downloadable alongside the deployed engine.
