export async function cleanupAfterCommit(
  cleanup: () => Promise<void>,
  onFailure?: () => void,
): Promise<void> {
  try {
    await cleanup();
  } catch {
    // Startup/periodic sweeps retry; neither cleanup nor telemetry can undo the
    // committed deletion or discard its success response and cleared cookies.
    try {
      onFailure?.();
    } catch {
      // Preserve the committed outcome even if the logger is unavailable.
    }
  }
}
