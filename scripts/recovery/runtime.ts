import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface CommandOptions {
  inputFile?: string;
  outputFile?: string;
  maxBytes?: number;
  timeoutMs?: number;
}
export type Command = (
  program: string,
  args: string[],
  options?: CommandOptions,
) => Promise<string>;
export const command: Command = async (program, args, options = {}) => {
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error())));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 600_000);
  const limit = options.maxBytes ?? (options.outputFile ? 1_073_741_824 : 32_768);
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error() : null, chunk);
    },
  });
  const chunks: Buffer[] = [];
  const output = options.outputFile
    ? pipeline(
        child.stdout,
        bounded,
        createWriteStream(options.outputFile, { flags: "wx", mode: 0o600 }),
      )
    : pipeline(child.stdout, bounded, async (source) => {
        for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
      });
  const input = options.inputFile
    ? pipeline(createReadStream(options.inputFile), child.stdin)
    : new Promise<void>((resolve, reject) => {
        child.stdin.once("error", reject);
        child.stdin.end(resolve);
      });
  try {
    await Promise.all([completed, input, output]);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    child.kill("SIGKILL");
    await Promise.allSettled([completed, input, output]);

    throw new Error("RECOVERY_COMMAND_FAILED");
  } finally {
    clearTimeout(timer);
  }
};

export async function privateDirectory(path: string) {
  if (dirname(resolve(path)) === resolve(path)) throw new Error("UNSAFE_RECOVERY_DIRECTORY");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("UNSAFE_RECOVERY_DIRECTORY");
  await chmod(path, 0o700);
}
export async function atomicJson(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, join(directory, name));
}
export async function readConfig(path: string): Promise<unknown> {
  if ((await lstat(path)).size > 4096) throw new Error("INVALID_RECOVERY_CONFIG");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export function configFields(
  value: unknown,
  fields: Record<string, "path" | "identifier">,
  error: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== Object.keys(fields).length) throw new Error(error);
  const result: Record<string, string> = {};
  for (const [key, type] of Object.entries(fields)) {
    const v = data[key];
    if (
      typeof v !== "string" ||
      !/^[^\0\r\n]{1,1024}$/.test(v) ||
      (type === "path"
        ? !isAbsolute(v) || dirname(resolve(v)) === resolve(v)
        : !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v))
    ) {
      throw new Error(error);
    }
    result[key] = v;
  }
  return result;
}
