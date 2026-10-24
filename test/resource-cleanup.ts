import { lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export async function attemptCleanup(
  steps: readonly { name: string; close(): unknown }[],
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.close();
    } catch {
      failed.push(step.name);
    }
  }
  return failed;
}

export async function removeFixtureDirectory(directory: string, prefix: string): Promise<void> {
  const path = resolve(directory);
  if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith(prefix)) {
    throw new Error("UNSAFE_FIXTURE_DIRECTORY");
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("UNSAFE_FIXTURE_DIRECTORY");
  await rm(path, { recursive: true, force: true });
}
