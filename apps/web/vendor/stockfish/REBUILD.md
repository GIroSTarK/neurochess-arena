# Stockfish 19 lite single-threaded distribution

This directory supplies the exact corresponding source and network for the unmodified
`stockfish@19.0.0` lite single-threaded JS/WASM pair. The Vite plugin verifies hashes
and the module's memory declaration before emitting or serving these assets. It
copies only the selected pair from npm; it never runs the package's postinstall
or downloads an engine at runtime. The application loads the worker on demand.

`manifest.json` records the npm integrity, source revision, build inputs, hashes,
options and limits. `stockfish-source.tar.gz` is the unmodified archive of npm's
reported source commit, including the upstream build scripts and vendored minifier.
The separately supplied NNUE file is embedded byte-for-byte in the WASM. Keep these
materials available for as long as this engine version is distributed.

## Reproduce and compare

Use Linux and the pinned Emscripten 3.1.7 container below. Run from this directory
with Docker; the build uses only the supplied inputs after the image is obtained.
The writable output directory must be empty. No modifications to engine sources
or options are required. The supplied `source-year.cjs` preload fixes the upstream
copyright-header year at 2026 so rebuilding in later years preserves the JS bytes.

```sh
mkdir -p rebuilt
docker run --rm --network none --cpus 4 \
  --mount "type=bind,source=$PWD,target=/inputs,readonly" \
  --mount "type=bind,source=$PWD/rebuilt,target=/output" \
  emscripten/emsdk@sha256:6143f5b3d58fe6e7faf9f279d27ea9ea975983ee2b5490478abda126a6762f34 \
  sh -c 'mkdir /build && tar -xzf /inputs/stockfish-source.tar.gz -C /build --strip-components=1 && cp /inputs/nn-61e7af4bb97d.nnue /build/src/ && cd /build && node --require /inputs/source-year.cjs build.js --lite --single-threaded --no-split --strict-em-check && cp src/stockfish-19-lite-single.js src/stockfish-19-lite-single.wasm /output/'
sha256sum rebuilt/stockfish-19-lite-single.js rebuilt/stockfish-19-lite-single.wasm
```

Both hashes must equal the manifest's engine hashes. The pinned compiler uses
SIMD, Asyncify, no Pthreads, no Syzygy, memory growth, 128 MiB initial memory and a
2 GiB maximum. Hash=16 MiB is a search option, not total worker memory. Browser
and JavaScript overhead are additional. Build configuration is in the archive's
`src/emscripten/wasm-makefile.mk`; the build entry point is `build.js`.

## Notices and release gate

Stockfish.js: copyright 2026 Chess.com, LLC; Nathan Rugg and contributors.
Stockfish: Tord Romstad, Marco Costalba, Joona Kiiski, Gary Linscott and the
contributors listed in `AUTHORS` and `Top CPU Contributors.txt`.
The embedded lite network is by Chris Bao (sscg13).
The unmodified loader retains its upstream notices. See `Copying.txt` for GPLv3.

Neurochess Arena's owner has not selected a repository license. Public distribution
requires that decision and an application/engine license compatibility review,
as recorded in ADR-0019. This engine package does not select an application license.
