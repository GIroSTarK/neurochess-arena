import { describe, expect, it, vi } from "vitest";

import { initialTarget } from "../test/analysis";
import { requestPath } from "../test/fixtures";

import { AnalysisProfileObsolete, createAnalysisApi } from "./analysis-client";
import { ApiFailure } from "./failures";

const gameId = initialTarget.gameId;
const account = "30c898bd-d430-4c9e-bd9e-1f44bd7a8fab";
const sample = {
  ply: 0,
  fen: initialTarget.fen,
  historyDigest: initialTarget.historyDigest,
  profileId: initialTarget.profileId,
  depth: 8,
  durationMs: 50,
  score: { kind: "cp" as const, value: 20 },
};
const retained = { ...sample, recordedAt: "2026-10-11T00:00:00.000Z" };
const identity = () => ({
  intent: "account" as const,
  expectedAccount: account,
  signal: new AbortController().signal,
  verify: () => Promise.resolve(),
});

describe("private analysis transport", () => {
  it("uses account fencing, private reads and scalar-only writes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ gameId, samples: [retained] }));
    const api = createAnalysisApi("http://localhost:3001", identity(), fetcher);
    const result = await api.write(gameId, [sample], new AbortController().signal);
    expect(result.samples).toEqual([retained]);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(requestPath(url)).toBe(`/games/${gameId}/analysis`);
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { "x-neurochess-identity": "account", "x-neurochess-expected-account": account },
      body: JSON.stringify({ samples: [sample] }),
    });
  });

  it("rejects cross-game, duplicate and mismatched retained responses", async () => {
    for (const payload of [
      { gameId: account, samples: [retained] },
      { gameId, samples: [retained, retained] },
      { gameId, samples: [{ ...retained, ply: 1 }] },
      { gameId, samples: [{ ...retained, historyDigest: "a".repeat(64) }] },
    ]) {
      const api = createAnalysisApi("http://localhost:3001", identity(), async () =>
        Response.json(payload),
      );
      await expect(api.write(gameId, [sample], new AbortController().signal)).rejects.toMatchObject(
        { kind: "malformed" },
      );
    }
  });

  it("rejects guest persistence before transport and fences identity changes", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = createAnalysisApi(
      "http://localhost:3001",
      { ...identity(), intent: "guest" },
      fetcher,
    );
    await expect(api.read(gameId, undefined, new AbortController().signal)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(fetcher).not.toHaveBeenCalled();
    let finish!: (value: Response) => void;
    const abort = new AbortController();
    const late = createAnalysisApi(
      "http://localhost:3001",
      { ...identity(), signal: abort.signal },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = late.read(gameId, undefined, new AbortController().signal);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    abort.abort();
    finish(Response.json({ gameId, samples: [retained], nextCursor: null }));
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("requires reload for obsolete profiles and redacts arbitrary failures", async () => {
    const api = createAnalysisApi("http://localhost:3001", identity(), async () =>
      Response.json(
        { code: "profile_obsolete", currentProfileId: "next-v2", requestId: "test" },
        { status: 409 },
      ),
    );
    await expect(api.write(gameId, [sample], new AbortController().signal)).rejects.toBeInstanceOf(
      AnalysisProfileObsolete,
    );
    const broken = createAnalysisApi("http://localhost:3001", identity(), async () => {
      throw new Error("private payload");
    });
    await expect(broken.read(gameId, undefined, new AbortController().signal)).rejects.toEqual(
      new ApiFailure("network"),
    );
  });

  it("rejects non-progressing, cross-account and cross-game read cursors", async () => {
    for (const nextCursor of [
      `${account}_${account}_0`,
      `${gameId}_${gameId}_0`,
      `${gameId}_${account}_0`,
    ]) {
      const api = createAnalysisApi("http://localhost:3001", identity(), async () =>
        Response.json({ gameId, samples: [retained], nextCursor }),
      );
      await expect(
        api.read(gameId, `${gameId}_${account}_0`, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "malformed" });
    }
  });
});
