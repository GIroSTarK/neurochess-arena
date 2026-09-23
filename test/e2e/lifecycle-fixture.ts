import { z } from "zod";

import { notifyParent, shutdownMessage } from "./lifecycle.js";

const mode = z
  .enum(["clean", "early-exit", "no-ready", "missing-ack", "failed", "hang", "hang-after-ack"])
  .parse(process.argv[2]);

if (mode === "early-exit") {
  process.exitCode = 1;
  process.disconnect();
} else {
  process.on("message", (message: unknown) => {
    if (!shutdownMessage.safeParse(message).success) throw new Error("Invalid fixture command");
    void shutdown();
  });
  if (mode !== "no-ready") await notifyParent("ready");
}

async function shutdown() {
  if (mode === "hang") return;
  if (mode === "failed") {
    process.exitCode = 1;
    await notifyParent("failed");
  } else if (mode !== "missing-ack") await notifyParent("stopped");
  if (mode !== "hang-after-ack") process.disconnect();
}
