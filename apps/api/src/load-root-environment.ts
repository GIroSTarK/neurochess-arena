import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export function loadRootEnvironment(): void {
  try {
    loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
