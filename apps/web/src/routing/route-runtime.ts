import type { ProfileResponse } from "@neurochess/contracts";

import { AccountFailure, type AuthApi } from "../api/auth-client";
import type { PublicIdentity } from "../api/identity";
import { type AuthEntry, readAuthEntry } from "../auth/auth-entry";
import { AccountController } from "../auth/controller";

import { IssuedResults } from "./issued-results";

export type PublicAccess = "guest" | "account" | "onboarding" | "required" | "unavailable";
export interface ResolvedPublicIdentity {
  readonly generation: number;
  readonly access: PublicAccess;
  readonly identity: PublicIdentity | null;
}
export interface ScopedRouteData<T> {
  readonly generation: number;
  // Router caches share this wrapper by identity; clear it in place so every
  // loader/action/fetcher alias loses its data synchronously, before revalidation.
  data: T | null;
}

interface PublicProjection {
  readonly access: PublicAccess;
}
interface ProfileProjection extends PublicProjection {
  profile: ProfileResponse | null;
}

export function waitForRouteResult<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new AccountFailure("cancelled"));
    // Observe transport rejection even when cancellation already won the race.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export class RouteRuntime {
  readonly account: AccountController;
  private disconnect: (() => void) | null = null;
  private readonly results = new IssuedResults<ScopedRouteData<unknown>>();
  private readonly profiles = new IssuedResults<ScopedRouteData<ProfileProjection>>();
  private readonly onboarding = new IssuedResults<ScopedRouteData<PublicProjection>>();
  private generation = 0;
  private readonly unsubscribe: () => void;
  private readonly actions = new Set<AbortController>();
  private location: { key: string; pathname: string; search: string; hash: string } | null = null;

  constructor(
    api: AuthApi,
    private readonly bootstrap?: AuthEntry,
  ) {
    this.account = new AccountController(api);
    this.unsubscribe = this.account.subscribe(() => {
      const state = this.account.getSnapshot();
      const generation = state.revision;
      if (generation === this.generation) {
        this.profiles.forEach((result) => {
          if (result.data) result.data.profile = state.profile;
        });
        if (state.phase === "account" && state.profile?.completed) {
          // Completing onboarding unlocks previously gated leaf reads without
          // changing identity or ending an already-authorized game owner.
          this.onboarding.forEach((result) => {
            result.data = null;
          });
          this.onboarding.clear();
        }
        return;
      }
      this.generation = generation;
      // Clear the actual values shared with loader/action/fetcher caches immediately.
      // Revalidation alone keeps old data alive until every new loader completes.
      this.results.forEach((result) => {
        result.data = null;
      });
      this.results.clear();
      this.profiles.clear();
      this.onboarding.clear();
    });
  }

  entry(url: URL): AuthEntry {
    return this.bootstrap?.active ? this.bootstrap : readAuthEntry(url);
  }

  get stopped() {
    return this.disconnect === null;
  }

  navigating(location: { key: string; pathname: string; search: string; hash: string }) {
    const previous = this.location;
    this.location = location;
    const hashOnly =
      previous?.pathname === location.pathname &&
      previous.search === location.search &&
      previous.hash !== location.hash;
    if (previous?.key === location.key || hashOnly) return;
    for (const action of this.actions) action.abort();
    this.actions.clear();
  }

  beginAction(signal: AbortSignal) {
    const abort = new AbortController();
    this.actions.add(abort);
    return {
      signal: AbortSignal.any([signal, abort.signal]),
      release: () => {
        this.actions.delete(abort);
      },
    };
  }

  async resolvePublicIdentity(
    signal: AbortSignal,
    requireProfile = true,
  ): Promise<ResolvedPublicIdentity> {
    const cancelled = () => signal.aborted;
    if (cancelled()) throw new AccountFailure("cancelled");
    this.disconnect ??= this.account.connect(false);
    await waitForRouteResult(this.account.resolve(), signal);
    if (
      this.account.getSnapshot().phase === "changing" ||
      this.account.getSnapshot().phase === "checking"
    ) {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          unsubscribe();
          reject(new AccountFailure("cancelled"));
        };
        const unsubscribe = this.account.subscribe(() => {
          const { phase } = this.account.getSnapshot();
          if (phase === "changing" || phase === "checking") return;
          unsubscribe();
          signal.removeEventListener("abort", cancel);
          resolve();
        });
        signal.addEventListener("abort", cancel, { once: true });
        if (cancelled()) cancel();
      });
    }
    if (cancelled()) throw new AccountFailure("cancelled");
    const state = this.account.getSnapshot();
    const access =
      state.phase === "account" && requireProfile && !state.profile?.completed
        ? "onboarding"
        : state.phase;
    if (access === "changing" || access === "checking") throw new AccountFailure("cancelled");
    return {
      generation: state.revision,
      access,
      identity:
        access === "guest" || access === "account" ? this.account.identity(requireProfile) : null,
    };
  }

  result<T>(generation: number, data: T): ScopedRouteData<T> {
    const result = {
      generation,
      data: generation === this.account.getSnapshot().revision ? data : null,
    };
    this.results.track(result);
    return result;
  }

  publicResult<T extends PublicProjection>(generation: number, data: T): ScopedRouteData<T> {
    const result = this.result(generation, data);
    if (result.data?.access === "onboarding") {
      const state = this.account.getSnapshot();
      if (state.phase === "account" && state.profile?.completed) result.data = null;
      else this.onboarding.track(result);
    }
    return result;
  }

  profileResult(generation: number, access: PublicAccess): ScopedRouteData<ProfileProjection> {
    const result = this.publicResult(generation, {
      access,
      profile: this.account.getSnapshot().profile,
    });
    if (result.data) this.profiles.track(result);
    return result;
  }

  stop() {
    for (const action of this.actions) action.abort();
    this.actions.clear();
    const disconnect = this.disconnect;
    this.disconnect = null;
    disconnect?.();
  }

  dispose() {
    this.stop();
    this.bootstrap?.retire();
    this.unsubscribe();
  }
}
