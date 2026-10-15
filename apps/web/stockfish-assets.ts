import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import manifest from "./vendor/stockfish/manifest.json" with { type: "json" };

const vendorDirectory = fileURLToPath(new URL("./vendor/stockfish/", import.meta.url));
const packageDirectory = dirname(createRequire(import.meta.url).resolve("stockfish/package.json"));
const prefix = `engines/${manifest.profileId}/`;

export function wasmMemoryLimits(bytes: Buffer): {
  initialBytes: number;
  maximumBytes: number;
  shared: boolean;
} {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error("Invalid WASM header");
  }
  let offset = 8;
  const unsigned = () => {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated WASM");
      value += (byte & 127) * 2 ** (7 * index);
      if (byte < 128) return value;
    }
    throw new Error("Invalid WASM integer");
  };
  while (offset < bytes.length) {
    const section = bytes[offset++];
    const size = unsigned();
    const end = offset + size;
    if (end > bytes.length) throw new Error("Truncated WASM section");
    if (section === 5) {
      if (unsigned() !== 1) throw new Error("Expected one WASM memory");
      const flags = unsigned();
      if (flags !== 1) throw new Error("Expected bounded unshared WASM memory");
      const initialBytes = unsigned() * 65536;
      const maximumBytes = unsigned() * 65536;
      if (offset !== end || initialBytes > maximumBytes) {
        throw new Error("Invalid WASM memory limits");
      }
      return { initialBytes, maximumBytes, shared: false };
    }
    offset = end;
  }
  throw new Error("WASM memory declaration missing");
}

export function embeddedNetworkMatches(bytes: Buffer, network: Buffer): boolean {
  let offset = 8;
  const unsigned = () => {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated WASM data");
      value += (byte & 127) * 2 ** (7 * index);
      if (byte < 128) return value;
    }
    throw new Error("Invalid WASM data integer");
  };
  const segments: { address: number; bytes: Buffer }[] = [];
  while (offset < bytes.length) {
    const section = bytes[offset++];
    const length = unsigned();
    const end = offset + length;
    if (end > bytes.length) throw new Error("Truncated WASM data section");
    if (section === 11) {
      const count = unsigned();
      for (let index = 0; index < count; index++) {
        if (unsigned() !== 0 || bytes[offset++] !== 0x41) {
          throw new Error("Unexpected WASM data mode");
        }
        const address = unsigned();
        if (bytes[offset++] !== 0x0b) throw new Error("Unexpected WASM data offset");
        const size = unsigned();
        if (address + size > 134217728 || offset + size > end) {
          throw new Error("WASM data exceeds memory");
        }
        segments.push({ address, bytes: bytes.subarray(offset, offset + size) });
        offset += size;
      }
    }
    offset = end;
  }
  // The linker omits zero-filled runs. Reconstruct static memory rather than
  // looking for a contiguous NNUE file in the encoded data sections.
  const memory = Buffer.alloc(
    Math.max(0, ...segments.map((segment) => segment.address + segment.bytes.length)),
  );
  for (const segment of segments) segment.bytes.copy(memory, segment.address);
  return memory.indexOf(network) !== -1;
}

export function loadStockfishDistribution(): { fileName: string; source: Buffer }[] {
  const files = Object.entries(manifest.files).map(([fileName, expected]) => {
    const source = readFileSync(
      join(expected.origin === "npm" ? join(packageDirectory, "bin") : vendorDirectory, fileName),
    );
    if (
      source.length !== expected.bytes ||
      createHash("sha256").update(source).digest("hex") !== expected.sha256
    ) {
      throw new Error(`Stockfish distribution verification failed: ${fileName}`);
    }
    return { fileName, source };
  });
  const wasm = files.find((file) => file.fileName.endsWith(".wasm"));
  const network = files.find((file) => file.fileName.endsWith(".nnue"));
  if (!wasm || !network) throw new Error("Stockfish engine/network missing");
  const memory = wasmMemoryLimits(wasm.source);
  if (memory.initialBytes !== 134217728 || memory.maximumBytes !== 2147483648 || memory.shared) {
    throw new Error("Stockfish memory policy mismatch");
  }
  if (!embeddedNetworkMatches(wasm.source, network.source)) {
    throw new Error("Stockfish embedded network mismatch");
  }
  files.push({
    fileName: "manifest.json",
    source: readFileSync(join(vendorDirectory, "manifest.json")),
  });
  for (const fileName of ["index.html", "REBUILD.md", "SOURCE-NOTICES.txt"]) {
    files.push({ fileName, source: readFileSync(join(vendorDirectory, fileName)) });
  }
  return files;
}

export function stockfishAssets(): Plugin {
  return {
    name: "stockfish-distribution",
    generateBundle() {
      for (const asset of loadStockfishDistribution()) {
        this.emitFile({ type: "asset", ...asset, fileName: prefix + asset.fileName });
      }
    },
    configureServer(server) {
      const files = loadStockfishDistribution();
      const base = server.config.base;
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];
        const asset = files.find((file) => path === `${base}${prefix}${encodeURI(file.fileName)}`);
        if (!asset) {
          next();
          return;
        }
        const type = asset.fileName.endsWith(".wasm")
          ? "application/wasm"
          : asset.fileName.endsWith(".js")
            ? "text/javascript"
            : asset.fileName.endsWith(".html")
              ? "text/html"
              : asset.fileName.endsWith(".json")
                ? "application/json"
                : "application/octet-stream";
        response.setHeader("Content-Type", type);
        response.end(asset.source);
      });
    },
  };
}
