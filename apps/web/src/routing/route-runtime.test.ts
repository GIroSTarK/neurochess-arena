import { afterEach, describe, expect, it } from "vitest";

import { createAuthApi } from "../api/auth-client";
import { GAME_ID, jsonResponse, OTHER_GAME_ID, requestPath } from "../test/fixtures";
import { createHttpMock } from "../test/http";

import { RouteRuntime } from "./route-runtime";

const session = {
  user: { id: GAME_ID, email: "private@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};
const runtimes: RouteRuntime[] = [];
function runtimeFor(http: ReturnType<typeof createHttpMock>) {
  const runtime = new RouteRuntime(createAuthApi("http://localhost:3001", { fetch: http.fetch }));
  runtimes.push(runtime);
  return runtime;
}
afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes.length = 0;
  sessionStorage.clear();
});

describe("public identity runtime", () => {
  it("deduplicates parallel leaf checks without letting one canceled loader cancel the others", async () => {
    const pending = Promise.withResolvers<void>();
    const http = createHttpMock({
      "GET /api/auth/get-session": async () => {
        await pending.promise;
        return jsonResponse(session);
      },
      "GET /profile": () => jsonResponse(profile),
    });
    const runtime = runtimeFor(http);
    const abort = new AbortController();
    const first = runtime.resolvePublicIdentity(abort.signal);
    const second = runtime.resolvePublicIdentity(new AbortController().signal);
    abort.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(http.fetch).toHaveBeenCalledOnce();
    pending.resolve();
    const resolved = await second;
    expect(resolved).toMatchObject({
      access: "account",
      identity: { intent: "account", expectedAccount: GAME_ID },
    });
    const third = await runtime.resolvePublicIdentity(new AbortController().signal);
    expect(third.generation).toBe(resolved.generation);
    expect(http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/profile")).toHaveLength(
      1,
    );
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/api/auth/get-session"),
    ).toHaveLength(2);
    http.assertNoUnexpectedRequests();
  });

  it("keeps onboarding mandatory for gameplay while admitting account and credential management", async () => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse({ ...profile, username: null, completed: false }),
    });
    const runtime = runtimeFor(http);
    const game = await runtime.resolvePublicIdentity(new AbortController().signal, true);
    expect(game).toMatchObject({ access: "onboarding", identity: null });
    const account = await runtime.resolvePublicIdentity(new AbortController().signal, false);
    expect(account).toMatchObject({ access: "account", identity: { expectedAccount: GAME_ID } });
    http.assertNoUnexpectedRequests();
  });

  it("invalidates gated entry data on profile completion without ending account authority", async () => {
    let completed = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () =>
        jsonResponse({ ...profile, completed, username: completed ? "Player" : null }),
    });
    const runtime = runtimeFor(http);
    const game = await runtime.resolvePublicIdentity(new AbortController().signal);
    const account = await runtime.resolvePublicIdentity(new AbortController().signal, false);
    const gated = runtime.publicResult(game.generation, { access: "onboarding", entry: null });
    const management = runtime.publicResult(account.generation, { access: "account" });
    completed = true;
    await runtime.account.refresh();
    expect(gated.data).toBeNull();
    expect(management.data).toEqual({ access: "account" });
    expect(account.identity?.signal.aborted).toBe(false);
    expect(runtime.account.getSnapshot().revision).toBe(account.generation);
    expect(
      runtime.publicResult(game.generation, { access: "onboarding", entry: null }).data,
    ).toBeNull();
    http.assertNoUnexpectedRequests();
  });

  it("does not apply profile or onboarding policies to generic result fields", async () => {
    let completed = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () =>
        jsonResponse({ ...profile, completed, username: completed ? "Renamed" : null }),
    });
    const runtime = runtimeFor(http);
    const { generation } = await runtime.resolvePublicIdentity(new AbortController().signal);
    const issued = runtime.result(generation, { profile: "unrelated" });
    const gated = runtime.result(generation, { access: "onboarding" });
    completed = true;
    await runtime.account.refresh();
    expect(issued.data).toEqual({ profile: "unrelated" });
    expect(gated.data).toEqual({ access: "onboarding" });
    expect(runtime.result(generation, { access: "onboarding" }).data).toEqual({
      access: "onboarding",
    });
    http.assertNoUnexpectedRequests();
  });

  it("updates explicit profile projections in place without changing account authority", async () => {
    let renamed = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse({ ...profile, username: renamed ? "Renamed" : "Player" }),
    });
    const runtime = runtimeFor(http);
    const { generation, access, identity } = await runtime.resolvePublicIdentity(
      new AbortController().signal,
    );
    const issued = runtime.profileResult(generation, access);
    const data = issued.data;
    expect(data?.profile?.username).toBe("Player");
    renamed = true;
    await runtime.account.refresh();
    expect(issued.data).toBe(data);
    expect(data?.profile?.username).toBe("Renamed");
    expect(runtime.account.getSnapshot().revision).toBe(generation);
    expect(identity?.signal.aborted).toBe(false);
    http.assertNoUnexpectedRequests();
  });

  it("clears issued values immediately, aborts old authority, and fences results arriving after a switch", async () => {
    let current = session;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(current),
      "GET /profile": () => jsonResponse(profile),
    });
    const runtime = runtimeFor(http);
    const identity = await runtime.resolvePublicIdentity(new AbortController().signal);
    const issued = runtime.result(identity.generation, { notice: "accepted" });
    const publicResult = runtime.publicResult(identity.generation, { access: identity.access });
    const profileResult = runtime.profileResult(identity.generation, identity.access);
    const pending = Promise.withResolvers<void>();
    const changing = runtime.account.transition(async () => {
      await pending.promise;
      current = { ...session, user: { ...session.user, id: OTHER_GAME_ID } };
    });
    expect(issued.data).toBeNull();
    expect(publicResult.data).toBeNull();
    expect(profileResult.data).toBeNull();
    expect(identity.identity?.signal.aborted).toBe(true);
    expect(runtime.account.getSnapshot()).toMatchObject({
      phase: "changing",
      session: null,
      profile: null,
    });
    let settled = false;
    const next = runtime.resolvePublicIdentity(new AbortController().signal).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve();
    await changing;
    expect(await next).toMatchObject({ identity: { expectedAccount: OTHER_GAME_ID } });
    expect(runtime.result(identity.generation, { notice: "accepted" }).data).toBeNull();
    expect(runtime.publicResult(identity.generation, { access: identity.access }).data).toBeNull();
    expect(runtime.profileResult(identity.generation, identity.access).data).toBeNull();
    expect(publicResult.data).toBeNull();
    expect(profileResult.data).toBeNull();
    http.assertNoUnexpectedRequests();
  });

  it("fails closed on a session-read failure, but keeps the lifetime for a same-identity profile update", async () => {
    let failed = false;
    let renamed = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () =>
        failed ? Promise.reject(new Error("private-failure-canary")) : jsonResponse(session),
      "GET /profile": () => jsonResponse({ ...profile, username: renamed ? "Renamed" : "Player" }),
    });
    const runtime = runtimeFor(http);
    const identity = await runtime.resolvePublicIdentity(new AbortController().signal);
    const issued = runtime.result(identity.generation, { access: "account" });
    renamed = true;
    await runtime.account.refresh();
    expect(runtime.account.getSnapshot().profile?.username).toBe("Renamed");
    expect(runtime.account.getSnapshot().revision).toBe(identity.generation);
    expect(identity.identity?.signal.aborted).toBe(false);
    expect(issued.data).toEqual({ access: "account" });
    failed = true;
    await runtime.account.refresh();
    expect(issued.data).toBeNull();
    expect(identity.identity?.signal.aborted).toBe(true);
    expect(await runtime.resolvePublicIdentity(new AbortController().signal)).toMatchObject({
      access: "unavailable",
      identity: null,
    });
    expect(JSON.stringify(runtime.account.getSnapshot())).not.toMatch(
      /private-failure|private@example|Renamed/,
    );
    http.assertNoUnexpectedRequests();
  });
});
