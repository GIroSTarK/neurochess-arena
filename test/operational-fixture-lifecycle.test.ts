import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Command } from "../scripts/recovery/runtime.js";

import { closeDeploymentFixture } from "./deployment/lifecycle.js";
import { environment } from "./recovery/environment.js";
import { closeRecoveryScenario } from "./recovery/lifecycle.js";
import { promote } from "./recovery/promotion.js";

const directories: string[] = [];
async function directory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}
const exists = async (path: string) =>
  readFile(join(path, "owned")).then(
    () => true,
    () => false,
  );

afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("deployment fixture teardown", () => {
  it("removes its directory when setup fails before Compose is configured", async () => {
    const path = await directory("neurochess-deployment-");
    await closeDeploymentFixture({ directory: path, sockets: [], browsers: [] }, true);
    await expect(readFile(path)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("attempts all sockets, browsers, Compose, and directory removal after failures", async () => {
    const path = await directory("neurochess-deployment-");
    await writeFile(join(path, "owned"), "fixture");
    const events: string[] = [];
    await expect(
      closeDeploymentFixture({
        directory: path,
        sockets: [
          {
            terminate() {
              events.push("socket 1");
              throw new Error("private socket");
            },
          },
          {
            terminate() {
              events.push("socket 2");
            },
          },
        ],
        browsers: [
          {
            async close() {
              events.push("browser 1");
              throw new Error("private browser");
            },
          },
          {
            async close() {
              events.push("browser 2");
            },
          },
        ],
        compose() {
          events.push("compose");
          throw new Error("private compose");
        },
      }),
    ).rejects.toThrow(/^Deployment fixture cleanup failed: socket, browser, Compose$/);
    expect(events).toEqual(["socket 1", "socket 2", "browser 1", "browser 2", "compose"]);
    expect(await exists(path)).toBe(false);
  });

  it("preserves a scenario failure and reports additional failures through fixed labels", async () => {
    const path = await directory("neurochess-deployment-");
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = new Error("original scenario failure");
    async function scenario() {
      let failed = false;
      try {
        throw original;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await closeDeploymentFixture(
          {
            directory: path,
            sockets: [],
            browsers: [],
            compose() {
              throw new Error("private cleanup sentinel");
            },
          },
          failed,
        );
      }
    }
    await expect(scenario()).rejects.toBe(original);
    expect(report.mock.calls).toEqual([["Deployment fixture cleanup failed: Compose"]]);
  });

  it.each(["wrong-prefix-", "neurochess-deployment-parent-"])(
    "refuses unsafe deletion targets (%s)",
    async (prefix) => {
      const parent = await directory(prefix);
      const path =
        prefix === "wrong-prefix-" ? parent : await mkdtemp(join(parent, "neurochess-deployment-"));
      await writeFile(join(path, "owned"), "keep");
      await expect(
        closeDeploymentFixture({ directory: path, sockets: [], browsers: [] }),
      ).rejects.toThrow(/^Deployment fixture cleanup failed: temporary directory$/);
      expect(await exists(path)).toBe(true);
    },
  );

  it("refuses a fixture-shaped symlink without removing its target", async () => {
    const target = await directory("unrelated-deployment-");
    await writeFile(join(target, "owned"), "keep");
    const path = await directory("neurochess-deployment-");
    await rm(path, { recursive: true, force: true });
    await symlink(target, path, "junction");
    await expect(
      closeDeploymentFixture({ directory: path, sockets: [], browsers: [] }),
    ).rejects.toThrow(/^Deployment fixture cleanup failed: temporary directory$/);
    expect(await exists(target)).toBe(true);
  });
});

function recordingCommand(fail: (args: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  const run: Command = async (program, args) => {
    calls.push([program, ...args]);
    if (fail(args)) throw new Error("private command sentinel");
    if (args[0] === "port") return "127.0.0.1:12345";
    if (args[0] === "inspect") return "false";
    return "";
  };
  return { run, calls };
}
function cleanupCalls(calls: string[][]) {
  return calls.filter((args) => args.includes("rm") || args.includes("down"));
}

describe("recovery infrastructure", () => {
  it("continues through relay and Compose failures to source-network removal", async () => {
    const path = await directory("nc-recovery-drill-");
    const { run, calls } = recordingCommand((args) => args[0] === "rm" || args.includes("down"));
    const infra = await environment(path, run);
    calls.length = 0;
    await expect(infra.close()).rejects.toThrow(
      /^Recovery fixture cleanup failed: source container, source relay, target relay, recovery Compose$/,
    );
    const cleanup = cleanupCalls(calls);
    expect(
      cleanup.map((args) =>
        args.includes("down") ? "Compose" : args[1] === "network" ? "network" : "container",
      ),
    ).toEqual(["container", "container", "container", "Compose", "network"]);
    expect(cleanup.at(-1)).toEqual([
      "docker",
      "network",
      "rm",
      expect.stringMatching(/^nc-recovery-/),
    ]);
  });

  it.each(["network", "source", "relay", "Compose"])(
    "cleans partially acquired resources after %s setup fails",
    async (stage) => {
      const path = await directory("nc-recovery-drill-");
      const original = new Error("setup sentinel");
      const { run, calls } = recordingCommand();
      const failing: Command = async (program, args, options) => {
        const result = await run(program, args, options);
        if (
          (stage === "network" && args[0] === "network" && args[1] === "create") ||
          (stage === "source" && args[0] === "run" && !args.includes("bridge")) ||
          (stage === "relay" && args[0] === "run" && args.includes("bridge")) ||
          (stage === "Compose" && args.includes("up"))
        ) {
          throw original;
        }
        return result;
      };
      await expect(environment(path, failing)).rejects.toBe(original);
      const cleanup = cleanupCalls(calls);
      expect(cleanup.at(-1)?.slice(0, 3)).toEqual(["docker", "network", "rm"]);
      expect(cleanup.filter((args) => args[1] === "rm")).toHaveLength(
        stage === "network" ? 0 : stage === "source" ? 1 : 2,
      );
      expect(cleanup.some((args) => args.includes("down"))).toBe(stage === "Compose");
    },
  );

  it("preserves acquisition failure when cleanup also fails without leaking diagnostics", async () => {
    const path = await directory("nc-recovery-drill-");
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = new Error("original acquisition failure");
    const { run, calls } = recordingCommand((args) => args[0] === "rm");
    const failing: Command = async (program, args, options) => {
      const result = await run(program, args, options);
      if (args[0] === "network" && args[1] === "connect") throw original;
      return result;
    };
    await expect(environment(path, failing)).rejects.toBe(original);
    expect(cleanupCalls(calls).at(-1)?.slice(0, 3)).toEqual(["docker", "network", "rm"]);
    expect(report.mock.calls).toEqual([
      ["Recovery fixture cleanup failed: source container, source relay"],
    ]);
  });
});

describe("promotion teardown", () => {
  async function infrastructure() {
    const path = await directory("nc-recovery-drill-");
    const { run } = recordingCommand();
    return { path, infra: await environment(path, run) };
  }

  it("attempts promoted Compose after relay failure and never removes the recovered external volume", async () => {
    const { path, infra } = await infrastructure();
    const { run, calls } = recordingCommand((args) => args[0] === "rm" || args.includes("down"));
    const promoted = await promote(path, infra, join(path, "api.env"), run);
    calls.length = 0;
    await expect(promoted.close()).rejects.toThrow(
      /^Recovery fixture cleanup failed: promotion relay, promoted Compose$/,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "docker",
      "rm",
      "-f",
      expect.stringMatching(/^nc-promote-.*-relay$/),
    ]);
    expect(calls[1]).toContain("down");
    expect(
      calls.some((args) => args.includes("volume") || args.includes(infra.recovery.volume)),
    ).toBe(false);
  });

  it("cleans a partially created relay and preserves the promotion setup failure", async () => {
    const { path, infra } = await infrastructure();
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = new Error("promotion setup sentinel");
    const { run, calls } = recordingCommand((args) => args[0] === "rm");
    const failing: Command = async (program, args, options) => {
      const result = await run(program, args, options);
      if (args[0] === "run" && args.includes("bridge")) throw original;
      return result;
    };
    await expect(promote(path, infra, join(path, "api.env"), failing)).rejects.toBe(original);
    expect(
      cleanupCalls(calls).map((args) => (args.includes("down") ? "Compose" : "relay")),
    ).toEqual(["relay", "Compose"]);
    expect(report.mock.calls).toEqual([["Recovery fixture cleanup failed: promotion relay"]]);
  });
});

describe("recovery scenario teardown", () => {
  it("removes its directory when infrastructure acquisition returns no resources", async () => {
    const path = await directory("nc-recovery-drill-");
    await closeRecoveryScenario(
      { directory: path, prefix: "nc-recovery-drill-", resources: [] },
      true,
    );
    await expect(readFile(path)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("attempts every database/harness, infrastructure, then directory after failures", async () => {
    const path = await directory("nc-recovery-reconcile-");
    await writeFile(join(path, "owned"), "fixture");
    const events: string[] = [];
    await expect(
      closeRecoveryScenario({
        directory: path,
        prefix: "nc-recovery-reconcile-",
        resources: [
          {
            name: "database",
            close() {
              events.push("database");
              throw new Error("private database");
            },
          },
          {
            name: "harness",
            close() {
              events.push("harness");
            },
          },
        ],
        infrastructure() {
          events.push("infrastructure");
          throw new Error("private infra");
        },
      }),
    ).rejects.toThrow(/^Recovery fixture cleanup failed: database, infrastructure$/);
    expect(events).toEqual(["database", "harness", "infrastructure"]);
    expect(await exists(path)).toBe(false);
  });

  it("removes the owned directory when acquisition or createdb fails and keeps that failure primary", async () => {
    const path = await directory("nc-recovery-reconcile-");
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = new Error("createdb failure");
    let infrastructureClosed = false;
    async function scenario() {
      let failed = false;
      try {
        throw original;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await closeRecoveryScenario(
          {
            directory: path,
            prefix: "nc-recovery-reconcile-",
            resources: [],
            infrastructure() {
              infrastructureClosed = true;
              throw new Error("private cleanup sentinel");
            },
          },
          failed,
        );
      }
    }
    await expect(scenario()).rejects.toBe(original);
    expect(infrastructureClosed).toBe(true);
    expect(report.mock.calls).toEqual([["Recovery fixture cleanup failed: infrastructure"]]);
    await expect(readFile(path)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("refuses an unrelated directory while still closing infrastructure", async () => {
    const path = await directory("unrelated-recovery-");
    await writeFile(join(path, "owned"), "keep");
    let closed = false;
    await expect(
      closeRecoveryScenario({
        directory: path,
        prefix: "nc-recovery-drill-",
        resources: [],
        infrastructure() {
          closed = true;
        },
      }),
    ).rejects.toThrow(/^Recovery fixture cleanup failed: temporary directory$/);
    expect(closed).toBe(true);
    expect(await exists(path)).toBe(true);
  });
});
