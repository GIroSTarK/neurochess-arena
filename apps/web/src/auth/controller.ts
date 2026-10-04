import type {
  AuthSessionResponse,
  ProfileResponse,
  ProfileUpdateRequest,
} from "@neurochess/contracts";

import type { AiIdentity } from "../api/ai-client";
import {
  accountError,
  type AccountErrorCode,
  AccountFailure,
  type AuthApi,
} from "../api/auth-client";
import { ApiFailure } from "../api/failures";

export interface AccountState {
  phase: "checking" | "changing" | "guest" | "account" | "required" | "unavailable";
  session: AuthSessionResponse;
  profile: ProfileResponse | null;
  revision: number;
  issue: AccountErrorCode | null;
  deletion: "none" | "pending" | "deleted" | "uncertain";
}

const intentKey = "neurochess.account-intent";
function accountIntent(): boolean {
  try {
    return sessionStorage.getItem(intentKey) === "account";
  } catch {
    return false;
  }
}
function rememberIntent(account: boolean) {
  try {
    if (account) sessionStorage.setItem(intentKey, "account");
    else sessionStorage.removeItem(intentKey);
  } catch {
    /* Page-memory fencing still works when browser storage is unavailable. */
  }
}
const sessionKey = (session: AuthSessionResponse) =>
  session ? `${session.user.id}:${session.session.expiresAt}` : "guest";

export class AccountController {
  private state: AccountState = {
    phase: "checking",
    session: null,
    profile: null,
    revision: 0,
    issue: null,
    deletion: "none",
  };
  private readonly listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private checking: { abort: AbortController; promise: Promise<void> } | null = null;
  private operation: AbortController | null = null;
  private channel: BroadcastChannel | null = null;
  private remoteTimer: ReturnType<typeof setTimeout> | undefined;
  private expectedAccount = accountIntent();
  private resolvedKey: string | null = null;
  private lastCheckedAt = 0;

  constructor(readonly api: AuthApi) {}
  readonly getSnapshot = () => this.state;
  get transitionPending() {
    return this.operation !== null && !this.operation.signal.aborted;
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<AccountState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private invalidate(phase: AccountState["phase"] = "checking") {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.resolvedKey = null;
    this.publish({
      phase,
      session: null,
      profile: null,
      revision: this.state.revision + 1,
      issue: null,
    });
  }
  private cancelCheck() {
    this.checking?.abort.abort();
    this.checking = null;
  }
  private cancelOperation() {
    const operation = this.operation;
    this.operation = null;
    operation?.abort();
  }
  connect(refreshOnConnect = true) {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("neurochess.identity");
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "profile-changed") {
          this.cancelCheck();
          void this.refresh();
          return;
        }
        if (event.data !== "changing" && event.data !== "changed") return;
        this.cancelCheck();
        this.cancelOperation();
        this.invalidate(event.data === "changing" ? "changing" : "checking");
        clearTimeout(this.remoteTimer);
        if (event.data === "changed") void this.refresh();
        else {
          this.remoteTimer = setTimeout(() => {
            this.publish({ phase: "checking" });
            void this.refresh();
          }, 12_000);
        }
      };
    }
    const timer = setInterval(() => void this.refresh(), 15_000);
    const focus = () => {
      if (document.visibilityState !== "hidden") void this.refresh();
    };
    const hide = () => {
      this.cancelCheck();
      this.cancelOperation();
      this.invalidate();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", focus);
    if (refreshOnConnect) void this.refresh();
    return () => {
      clearInterval(timer);
      clearTimeout(this.remoteTimer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", focus);
      this.channel?.close();
      this.channel = null;
      hide();
    };
  }

  resolve(): Promise<void> {
    if (this.checking) return this.checking.promise;
    if (this.state.phase === "checking" || Date.now() - this.lastCheckedAt >= 15_000) {
      return this.refresh();
    }
    return Promise.resolve();
  }

  refresh(): Promise<void> {
    if (this.state.phase === "changing") return Promise.resolve();
    if (this.checking) return this.checking.promise;
    const abort = new AbortController();
    const promise = this.readIdentity(abort.signal).finally(() => {
      if (this.checking?.abort === abort) this.checking = null;
    });
    this.checking = { abort, promise };
    return promise;
  }
  private async readIdentity(signal: AbortSignal) {
    const cancelled = () => signal.aborted;
    // A changing cookie may invalidate the profile read or its confirmation. Retry
    // identity resolution, but do not spin indefinitely while another tab signs in.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const session = await this.api.session(signal);
        if (cancelled()) return;
        this.lastCheckedAt = Date.now();
        const key = sessionKey(session);
        if (key !== this.resolvedKey) this.invalidate();
        if (!session) {
          this.resolvedKey = key;
          this.publish({ phase: this.expectedAccount ? "required" : "guest" });
          return;
        }
        this.expectedAccount = true;
        rememberIntent(true);
        const profile = await this.api.profile(signal, session.user.id).catch((error: unknown) => {
          const code = accountError(error);
          if (
            (code === "PROFILE_UNAVAILABLE" || code === "AUTH_UNAVAILABLE") &&
            key === this.resolvedKey &&
            this.state.phase === "account" &&
            this.state.profile
          ) {
            // A profile outage does not revoke the session; still confirm it below.
            return this.state.profile;
          }
          throw error;
        });
        if (cancelled()) return;
        const confirmation = await this.api.session(signal);
        if (cancelled()) return;
        if (sessionKey(confirmation) !== key) {
          this.invalidate();
          continue;
        }
        this.resolvedKey = key;
        this.publish({ phase: "account", session, profile, issue: null });
        return;
      } catch (error) {
        if (cancelled()) return;
        if (accountError(error) === "PROFILE_UNAUTHORIZED") {
          this.invalidate();
          continue;
        }
        this.invalidate("unavailable");
        this.publish({ issue: accountError(error) });
        return;
      }
    }
    this.invalidate("required");
    this.publish({ issue: "AUTH_UNAUTHORIZED" });
  }
  identity(requireProfile = true): AiIdentity {
    const signal = this.lifetime.signal;
    const cancelled = () => signal.aborted;
    const intent = this.state.phase === "account" ? "account" : "guest";
    return {
      intent,
      expectedAccount: this.state.session?.user.id ?? "guest",
      signal,
      verify: async () => {
        if (cancelled()) throw new ApiFailure("cancelled");
        if (Date.now() - this.lastCheckedAt >= 15_000) await this.refresh();
        if (
          cancelled() ||
          this.state.phase !== intent ||
          (requireProfile && intent === "account" && !this.state.profile?.completed)
        ) {
          throw new ApiFailure("cancelled");
        }
      },
      lost: () => {
        if (signal.aborted) return;
        if (intent === "guest") {
          void this.refresh();
          return;
        }
        this.cancelCheck();
        this.invalidate();
        void this.refresh();
      },
    };
  }
  async chooseGuest() {
    this.cancelOperation();
    this.publish({ deletion: "none" });
    this.expectedAccount = false;
    rememberIntent(false);
    this.cancelCheck();
    this.invalidate();
    await this.refresh();
  }
  async transition<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    deleting = false,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new AccountFailure("cancelled");
    this.cancelOperation();
    this.cancelCheck();
    const abort = new AbortController();
    this.operation = abort;
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    this.expectedAccount = true;
    this.publish({ deletion: deleting ? "pending" : "none" });
    rememberIntent(true);
    this.invalidate("changing");
    this.channel?.postMessage("changing");
    let rejectCancellation: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = () => reject(new AccountFailure("cancelled"));
      abort.signal.addEventListener("abort", rejectCancellation, { once: true });
      if (abort.signal.aborted) rejectCancellation();
    });
    try {
      const result = await Promise.race([operation(abort.signal), cancellation]);
      if (abort.signal.aborted) throw new AccountFailure("cancelled");
      return result;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (rejectCancellation) abort.signal.removeEventListener("abort", rejectCancellation);
      if (this.operation === abort && (!abort.signal.aborted || signal?.aborted)) {
        this.publish({ phase: "checking" });
        this.channel?.postMessage("changed");
        await this.refresh();
      }
      if (this.operation === abort) this.operation = null;
    }
  }
  async signOut(signal?: AbortSignal) {
    const expectedAccount = this.state.session?.user.id;
    if (!expectedAccount) return;
    try {
      await this.transition((signal) => this.api.signOut(signal, expectedAccount), false, signal);
    } catch (error) {
      if (accountError(error) !== "cancelled") this.publish({ issue: accountError(error) });
    }
  }
  async deleteAccount(signal?: AbortSignal) {
    const expectedAccount = this.state.session?.user.id;
    if (!expectedAccount || this.operation || this.state.deletion === "pending") return;
    try {
      await this.transition(
        (signal) => this.api.deleteAccount(signal, expectedAccount),
        true,
        signal,
      );
      this.publish({ deletion: "deleted" });
    } catch (error) {
      const code = accountError(error);
      if (code === "cancelled") {
        if (this.getSnapshot().deletion === "pending") this.publish({ deletion: "uncertain" });
        return;
      }
      this.publish({
        deletion: code === "AUTH_UNAVAILABLE" ? "uncertain" : "none",
        issue: code,
      });
    }
  }
  async saveProfile(value: ProfileUpdateRequest, requestSignal?: AbortSignal) {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    const cancelled = () => signal.aborted;
    await this.refresh();
    if (cancelled() || this.state.phase !== "account") throw new AccountFailure("cancelled");
    try {
      await this.api.saveProfile(
        value,
        !this.state.profile?.completed && value.username !== undefined,
        signal,
        this.state.session?.user.id,
      );
      if (cancelled()) throw new AccountFailure("cancelled");
      this.cancelCheck();
      await this.refresh();
      if (cancelled()) throw new AccountFailure("cancelled");
      this.channel?.postMessage("profile-changed");
    } catch (error) {
      if (!cancelled() && accountError(error) === "PROFILE_UNAUTHORIZED") {
        this.cancelCheck();
        this.invalidate();
        await this.refresh();
        throw new AccountFailure("cancelled");
      }
      throw error;
    }
  }
}
