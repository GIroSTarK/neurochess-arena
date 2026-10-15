import { execFile } from "node:child_process";
import { readFile, stat, statfs } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function command(program: string, args: string[]): Promise<string> {
  try {
    const result = await execute(program, args, {
      timeout: 20_000,
      maxBuffer: 32_768,
      windowsHide: true,
      killSignal: "SIGKILL",
    });
    return result.stdout;
  } catch {
    throw new Error("MONITOR_COMMAND_FAILED");
  }
}
export async function readJson(path: string, maxBytes = 4096): Promise<unknown> {
  if ((await stat(path)).size > maxBytes) throw new Error("MONITOR_INPUT_TOO_LARGE");
  const data = await readFile(path, "utf8");
  if (Buffer.byteLength(data) > maxBytes) throw new Error("MONITOR_INPUT_TOO_LARGE");
  return JSON.parse(data) as unknown;
}
export interface MonitorConfig {
  compartmentId: string;
  topicId: string;
  containerName: string;
  directory: string;
  diskPath: string;
  backupStatusFile: string;
  backupMaxAgeSeconds?: number;
  apiOrigin: string;
  webOrigin: string;
}
export function parseConfig(value: unknown): MonitorConfig {
  if (value === null || typeof value !== "object") throw new Error("INVALID_MONITOR_CONFIG");
  const v = value as Record<string, unknown>;
  const text = (key: string, expression: RegExp) => {
    if (typeof v[key] !== "string" || !expression.test(v[key])) {
      throw new Error("INVALID_MONITOR_CONFIG");
    }
    return v[key];
  };
  const path = (key: string) => {
    const p = text(key, /^[^\0\r\n]{1,1024}$/);
    if (!isAbsolute(p)) throw new Error("INVALID_MONITOR_CONFIG");
    return p;
  };
  const maxAge = v.backupMaxAgeSeconds;
  const origin = (key: string) => {
    const value = text(key, /^https:\/\/[^\s]{1,512}$/);
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) {
      throw new Error("INVALID_MONITOR_CONFIG");
    }
    return value;
  };
  if (
    maxAge !== undefined &&
    (typeof maxAge !== "number" ||
      !Number.isSafeInteger(maxAge) ||
      maxAge < 60 ||
      maxAge > 31_536_000)
  ) {
    throw new Error("INVALID_MONITOR_CONFIG");
  }
  return {
    compartmentId: text("compartmentId", /^ocid1\.compartment\.oc1\.\.[a-zA-Z0-9]{1,256}$/),
    topicId: text("topicId", /^ocid1\.onstopic\.oc1\.eu-frankfurt-1\.[a-zA-Z0-9.]{1,256}$/),
    containerName: text("containerName", /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
    directory: path("directory"),
    diskPath: path("diskPath"),
    backupStatusFile: path("backupStatusFile"),
    apiOrigin: origin("apiOrigin"),
    webOrigin: origin("webOrigin"),
    ...(maxAge === undefined ? {} : { backupMaxAgeSeconds: maxAge }),
  };
}
export async function collectContext(config: MonitorConfig) {
  const edgeAvailable = await probeEdge(config.apiOrigin, config.webOrigin);
  const disk = await statfs(config.diskPath);
  let backup: unknown;
  try {
    backup = await readJson(config.backupStatusFile);
  } catch {
    /* Missing evidence remains explicit. */
  }
  return {
    edgeAvailable,
    diskUsedPercent: disk.blocks > 0 ? (1 - disk.bavail / disk.blocks) * 100 : 100,
    backup,
    ...(config.backupMaxAgeSeconds === undefined
      ? {}
      : { backupMaxAgeSeconds: config.backupMaxAgeSeconds }),
  };
}
export async function probeEdge(
  apiOrigin: string,
  webOrigin: string,
  fetcher: typeof fetch = fetch,
) {
  const results = await Promise.allSettled(
    [apiOrigin + "/health", webOrigin + "/"].map(async (url) => {
      const response = await fetcher(url, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      return response.status === 200;
    }),
  );
  return results.every((result) => result.status === "fulfilled" && result.value);
}
export async function scrape(containerName: string) {
  const raw = await command("docker", [
    "exec",
    containerName,
    "node",
    "-e",
    "fetch('http://127.0.0.1:3001/internal/operations',{signal:AbortSignal.timeout(12000)}).then(async r=>{if(!r.ok)throw Error();process.stdout.write(await r.text())}).catch(()=>process.exit(1))",
  ]);
  return JSON.parse(raw) as unknown;
}
export async function publish(payload: unknown) {
  const response = JSON.parse(
    await command("oci", [
      "monitoring",
      "metric-data",
      "post",
      "--metric-data",
      JSON.stringify(payload),
      "--batch-atomicity",
      "ATOMIC",
      "--endpoint",
      "https://telemetry-ingestion.eu-frankfurt-1.oraclecloud.com",
      "--auth",
      "instance_principal",
      "--region",
      "eu-frankfurt-1",
      "--no-retry",
      "--connection-timeout",
      "5",
      "--read-timeout",
      "10",
    ]),
  ) as { data?: { "failed-metrics-count"?: unknown } };
  if (response.data?.["failed-metrics-count"] !== 0) throw new Error("MONITOR_EXPORT_FAILED");
}
