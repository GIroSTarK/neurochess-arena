import { attemptCleanup, removeFixtureDirectory } from "../resource-cleanup.ts";

export async function closeDeploymentFixture(
  fixture: {
    sockets: readonly { terminate(): unknown }[];
    browsers: readonly { close(): unknown }[];
    compose?: () => unknown;
    directory: string;
  },
  scenarioFailed = false,
): Promise<void> {
  const failed = await attemptCleanup([
    ...fixture.sockets.map((socket) => ({ name: "socket", close: () => socket.terminate() })),
    ...fixture.browsers.map((browser) => ({ name: "browser", close: () => browser.close() })),
    { name: "Compose", close: () => fixture.compose?.() },
    {
      name: "temporary directory",
      close: () => removeFixtureDirectory(fixture.directory, "neurochess-deployment-"),
    },
  ]);
  if (failed.length) {
    const message = "Deployment fixture cleanup failed: " + failed.join(", ");
    if (scenarioFailed) console.error(message);
    else throw new Error(message);
  }
}
