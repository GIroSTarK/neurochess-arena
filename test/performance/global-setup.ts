import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { startBrowserTestServer } from "../e2e/lifecycle";

export default async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "neurochess-performance-build-"));
  process.env.PERFORMANCE_BUILD_DIRECTORY = directory;
  const cleanup = async () => {
    if (
      dirname(directory) !== tmpdir() ||
      !basename(directory).startsWith("neurochess-performance-build-")
    ) {
      throw new Error("Unexpected performance build directory");
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const stop = await startBrowserTestServer(new URL("../e2e/server.ts", import.meta.url), {
      args: ["--production-web", directory],
      startupTimeout: 60_000,
    });
    return async () => {
      try {
        await stop();
      } finally {
        await cleanup();
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
