import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { currentAnalysisProfile } from "./profiles.js";

it("binds the writable server profile to the distributed engine, options and source provenance", async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../../../web/vendor/stockfish/manifest.json", import.meta.url), "utf8"),
  );
  expect(createHash("sha256").update(JSON.stringify(manifest)).digest("hex")).toBe(
    currentAnalysisProfile.manifestSha256,
  );
  expect(manifest).toMatchObject({
    profileId: currentAnalysisProfile.id,
    rank: currentAnalysisProfile.rank,
    score: {
      depth: [0, currentAnalysisProfile.maxDepth],
      durationMs: [0, currentAnalysisProfile.maxDurationMs],
    },
  });
});
