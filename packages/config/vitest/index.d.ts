import type { InlineConfig } from "vitest/node";

export const baseTestConfig: Pick<
  InlineConfig,
  "clearMocks" | "passWithNoTests" | "restoreMocks" | "unstubEnvs" | "unstubGlobals"
>;
