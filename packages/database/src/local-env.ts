import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export function loadRootEnvironment(): void {
  const environmentFile = fileURLToPath(new URL("../../../.env", import.meta.url));

  try {
    loadEnvFile(environmentFile);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
