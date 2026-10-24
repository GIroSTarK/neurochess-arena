import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { analysisProfiles, currentAnalysisProfile } from "./profiles.js";

it("advances the engine profile without changing the provenance of saved Stockfish 19.0.0 samples", () => {
  expect(currentAnalysisProfile).toMatchObject({ id: "sf19-lite-single-v2", rank: 2 });
  expect(analysisProfiles.known).toContainEqual({
    id: "sf19-lite-single-v1",
    rank: 1,
    manifestSha256: "c9754d2b8f63e155af343a1db8fbe569a3a912a1a5d0d8343d10b175a85f7a76",
    maxDepth: 18,
    maxDurationMs: 3000,
  });
});

it("retains the previous profile's immutable manifest", async () => {
  const previous: unknown = JSON.parse(
    await readFile(
      new URL("../../../web/vendor/stockfish/profiles/sf19-lite-single-v1.json", import.meta.url),
      "utf8",
    ),
  );
  expect(createHash("sha256").update(JSON.stringify(previous)).digest("hex")).toBe(
    analysisProfiles.known.find((profile) => profile.id === "sf19-lite-single-v1")?.manifestSha256,
  );
});

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
    package: { version: "19.0.1" },
    score: {
      depth: [0, currentAnalysisProfile.maxDepth],
      durationMs: [0, currentAnalysisProfile.maxDurationMs],
    },
  });
});
