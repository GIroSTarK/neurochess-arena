import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { command } from "../../scripts/recovery/runtime.ts";

const assets = {
  "win32-x64": [
    "windows-amd64.zip",
    "f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7",
  ],
  "linux-x64": [
    "linux-amd64.tar.gz",
    "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10",
  ],
  "linux-arm64": [
    "linux-arm64.tar.gz",
    "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4",
  ],
};
const directory = await mkdtemp(join(tmpdir(), "nc-age-drill-"));
try {
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("Unsupported recovery drill platform");
  const response = await fetch(
    `https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-${asset[0]}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok) throw new Error("Age download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset[1]) {
    throw new Error("Age checksum mismatch");
  }
  const archive = join(directory, asset[0]);
  await writeFile(archive, bytes);
  await command("tar", ["-xf", archive, "-C", directory]);
  const agePath = join(directory, "age");
  const evidenceFile = join(directory, "evidence.json");
  const child = spawn(
    process.execPath,
    [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.recovery.config.ts"],
    {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        RECOVERY_EVIDENCE_FILE: evidenceFile,
        PATH: `${agePath}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      },
    },
  );
  process.exitCode = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveCode(code ?? 1));
  });
  if (process.exitCode === 0) process.stdout.write((await readFile(evidenceFile, "utf8")) + "\n");
} finally {
  assert.equal(dirname(directory), tmpdir());
  await rm(directory, { recursive: true, force: true });
}
