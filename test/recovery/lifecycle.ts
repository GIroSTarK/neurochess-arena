import type { Command } from "../../scripts/recovery/runtime.js";
import { attemptCleanup, removeFixtureDirectory } from "../resource-cleanup.js";

function reportFailures(failed: readonly string[], scenarioFailed: boolean): void {
  if (!failed.length) return;
  const message = "Recovery fixture cleanup failed: " + failed.join(", ");
  if (scenarioFailed) console.error(message);
  else throw new Error(message);
}

export async function closeRecoveryEnvironment(
  fixture: {
    containers: readonly { name: string; container: string }[];
    compose?: readonly string[];
    network?: string;
  },
  command: Command,
  setupFailed = false,
): Promise<void> {
  const failed = await attemptCleanup([
    ...fixture.containers.map(({ name, container }) => ({
      name,
      close: () => command("docker", ["rm", "-f", "--volumes", container]),
    })),
    {
      name: "recovery Compose",
      close: () =>
        fixture.compose &&
        command("docker", [...fixture.compose, "down", "--volumes", "--remove-orphans"]),
    },
    {
      name: "source network",
      close: () => fixture.network && command("docker", ["network", "rm", fixture.network]),
    },
  ]);
  reportFailures(failed, setupFailed);
}

export async function closePromotion(
  fixture: { relay?: string; compose?: readonly string[] },
  command: Command,
  setupFailed = false,
): Promise<void> {
  const failed = await attemptCleanup([
    {
      name: "promotion relay",
      close: () => fixture.relay && command("docker", ["rm", "-f", fixture.relay]),
    },
    // The promotion override declares the recovered volume external; only its
    // original recovery fixture may remove it, after promotion has shut down.
    {
      name: "promoted Compose",
      close: () =>
        fixture.compose &&
        command("docker", [...fixture.compose, "down", "--volumes", "--remove-orphans"]),
    },
  ]);
  reportFailures(failed, setupFailed);
}

export async function closeRecoveryScenario(
  fixture: {
    resources: readonly { name: string; close(): unknown }[];
    infrastructure?: () => unknown;
    directory: string;
    prefix: "nc-recovery-drill-" | "nc-recovery-reconcile-";
  },
  scenarioFailed = false,
): Promise<void> {
  const failed = await attemptCleanup([
    ...fixture.resources,
    { name: "infrastructure", close: () => fixture.infrastructure?.() },
    {
      name: "temporary directory",
      close: () => removeFixtureDirectory(fixture.directory, fixture.prefix),
    },
  ]);
  reportFailures(failed, scenarioFailed);
}
