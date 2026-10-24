export interface AnalysisProfile {
  readonly id: string;
  readonly rank: number;
  readonly manifestSha256: string;
  readonly maxDepth: number;
  readonly maxDurationMs: number;
}

// SHA-256 of UTF-8 JSON.stringify(manifest) binds engine/source/options regardless of whitespace.
// Keep previous entries immutable and readable when registering a new current profile.
const previousAnalysisProfile: AnalysisProfile = Object.freeze({
  id: "sf19-lite-single-v1",
  rank: 1,
  manifestSha256: "c9754d2b8f63e155af343a1db8fbe569a3a912a1a5d0d8343d10b175a85f7a76",
  maxDepth: 18,
  maxDurationMs: 3000,
});

export const currentAnalysisProfile: AnalysisProfile = Object.freeze({
  id: "sf19-lite-single-v2",
  rank: 2,
  manifestSha256: "fe9208942f8c8bccec13358f6db033cae7c1bc6de7a6c7870a084c02a4920756",
  maxDepth: 18,
  maxDurationMs: 3000,
});

export interface AnalysisProfiles {
  readonly current: AnalysisProfile;
  readonly known: readonly AnalysisProfile[];
}
export const analysisProfiles: AnalysisProfiles = Object.freeze({
  current: currentAnalysisProfile,
  known: Object.freeze([previousAnalysisProfile, currentAnalysisProfile]),
});

export class AnalysisProfileObsoleteError extends Error {
  constructor(readonly currentProfileId: string) {
    super("profile_obsolete");
  }
}
