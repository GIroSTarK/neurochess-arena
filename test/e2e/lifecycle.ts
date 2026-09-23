import { type ChildProcess, execFile, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const shutdownMessage = z.literal("shutdown");
export const serverMessage = z.enum(["ready", "stopped", "failed"]);

async function within<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function forceStop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000 },
        () => resolve(),
      );
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The child may have exited between the check and the process-group kill.
    }
  }
}

export async function startBrowserTestServer(
  entrypoint = new URL("./server.ts", import.meta.url),
  options: {
    args?: string[];
    startupTimeout?: number;
    shutdownTimeout?: number;
  } = {},
): Promise<() => Promise<void>> {
  const child = fork(fileURLToPath(entrypoint), options.args ?? [], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    execArgv: ["--conditions=development", "--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    detached: process.platform !== "win32",
  });
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let problem: Error | undefined;
  let started = false;
  let stopping = false;
  let stopped = false;
  let closed = false;
  let stopPromise: Promise<void> | undefined;

  const fail = (message: string) => {
    problem ??= new Error(message);
    ready.reject(problem);
  };
  child.on("message", (message: unknown) => {
    const parsed = serverMessage.safeParse(message);
    if (!parsed.success) {
      fail("Browser test server sent an invalid lifecycle message.");
    } else if (parsed.data === "ready" && !started && !stopping) {
      started = true;
      ready.resolve();
    } else if (parsed.data === "stopped" && stopping) {
      stopped = true;
    } else {
      fail("Browser test server reported a lifecycle failure.");
    }
  });
  child.on("error", () => fail("Browser test server process or IPC failed."));
  child.once("close", (code, signal) => {
    closed = true;
    if (!stopping || code !== 0 || signal !== null) {
      fail("Browser test server exited unexpectedly or with a failure status.");
    }
    exited.resolve();
  });

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      if (!closed && child.connected) {
        child.send("shutdown", (error) => {
          if (error) fail("Could not request browser test server shutdown.");
        });
      }
      try {
        await within(
          exited.promise,
          options.shutdownTimeout ?? 10_000,
          "Browser test server shutdown timed out; cleanup was not confirmed.",
        );
      } catch (error) {
        await forceStop(child);
        await within(exited.promise, 5_000, "Browser test server could not be terminated.");
        throw error;
      }
      if (problem) throw problem;
      if (!stopped) throw new Error("Browser test server exited without confirming cleanup.");
    })();
    return stopPromise;
  };

  try {
    await within(
      ready.promise,
      options.startupTimeout ?? 30_000,
      "Browser test server startup timed out.",
    );
  } catch (error) {
    // A failed setup does not return a teardown hook to Playwright.
    await stop().catch(() => undefined);
    throw error;
  }
  return stop;
}

export async function closeResources(
  steps: readonly { name: string; close: () => unknown }[],
): Promise<void> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.close();
    } catch {
      failed.push(step.name);
    }
  }
  // Only caller-owned resource names may reach reports, never underlying errors or credentials.
  if (failed.length) throw new Error("Browser test cleanup failed: " + failed.join(", "));
}

export async function notifyParent(message: z.infer<typeof serverMessage>): Promise<void> {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => {
      if (error) reject(new Error("Browser test server IPC failed."));
      else resolve();
    });
  });
}
