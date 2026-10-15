import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  embeddedNetworkMatches,
  loadStockfishDistribution,
  wasmMemoryLimits,
} from "./stockfish-assets";

describe("pinned Stockfish distribution", () => {
  it("verifies exact lite assets, embedded network, source and notices before serving or building", () => {
    const assets = loadStockfishDistribution();
    expect(assets.map((asset) => asset.fileName)).toEqual(
      expect.arrayContaining([
        "stockfish-19-lite-single.js",
        "stockfish-19-lite-single.wasm",
        "manifest.json",
        "index.html",
        "stockfish-source.tar.gz",
        "nn-61e7af4bb97d.nnue",
        "Copying.txt",
        "AUTHORS",
        "REBUILD.md",
        "SOURCE-NOTICES.txt",
      ]),
    );
    expect(assets.filter((asset) => /\.(?:wasm|js)$/.test(asset.fileName))).toHaveLength(2);
    const wasm = assets.find((asset) => asset.fileName.endsWith(".wasm"))!.source;
    expect(wasmMemoryLimits(wasm)).toEqual({
      initialBytes: 134217728,
      maximumBytes: 2147483648,
      shared: false,
    });
    const network = assets.find((asset) => asset.fileName.endsWith(".nnue"))!.source;
    expect(embeddedNetworkMatches(wasm, network)).toBe(true);
    const wrongNetwork = Buffer.from(network);
    wrongNetwork[0] = wrongNetwork[0]! ^ 1;
    expect(embeddedNetworkMatches(wasm, wrongNetwork)).toBe(false);
  });

  it("reads the module memory declaration and rejects malformed or unbounded memory", () => {
    const header = [0, 97, 115, 109, 1, 0, 0, 0];
    expect(() => wasmMemoryLimits(Buffer.from([...header, 5, 3, 1, 0, 1]))).toThrow();
    expect(() => wasmMemoryLimits(Buffer.from([0]))).toThrow();
    const wasm = readFileSync(
      new URL("../../node_modules/stockfish/bin/stockfish-19-lite-single.wasm", import.meta.url),
    );
    expect(wasmMemoryLimits(wasm).maximumBytes).toBe(2147483648);
  });
});
