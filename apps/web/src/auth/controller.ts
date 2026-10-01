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
  connect() {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("neurochess.identity");
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data !== "changing" && event.data !== "changed") return;
        this.cancelCheck();
        this.operation?.abort();
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
      this.operation?.abort();
      this.invalidate();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", focus);
    void this.refresh();
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
    try {
      const session = await this.api.session(signal);
      if (cancelled()) return;
      this.lastCheckedAt = Date.now();
      const key = sessionKey(session);
      if (key === this.resolvedKey) return;
      this.invalidate();
      if (!session) {
        this.resolvedKey = key;
        this.publish({ phase: this.expectedAccount ? "required" : "guest" });
        return;
      }
      this.expectedAccount = true;
      rememberIntent(true);
      const profile = await this.api.profile(signal, session.user.id);
      if (cancelled()) return;
      // A cookie can change while the profile request is in flight.
      const confirmation = await this.api.session(signal);
      if (cancelled()) return;
      if (sessionKey(confirmation) !== key) {
        this.cancelCheck();
        void this.refresh();
        return;
      }
      this.resolvedKey = key;
      this.publish({ phase: "account", session, profile });
    } catch (error) {
      if (cancelled()) return;
      this.invalidate("unavailable");
      this.publish({ issue: accountError(error) });
    }
  }
  identity(): AiIdentity {
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
          (intent === "account" && !this.state.profile?.completed)
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
    this.expectedAccount = false;
    rememberIntent(false);
    this.cancelCheck();
    this.invalidate();
    await this.refresh();
  }
  async transition<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.operation?.abort();
    this.cancelCheck();
    const abort = new AbortController();
    this.operation = abort;
    this.expectedAccount = true;
    rememberIntent(true);
    this.invalidate("changing");
    this.channel?.postMessage("changing");
    try {
      const result = await operation(abort.signal);
      if (abort.signal.aborted) throw new AccountFailure("cancelled");
      return result;
    } finally {
      if (!abort.signal.aborted) {
        this.publish({ phase: "checking" });
        this.channel?.postMessage("changed");
        await this.refresh();
      }
      if (this.operation === abort) this.operation = null;
    }
  }
  async signOut() {
    try {
      await this.transition((signal) => this.api.signOut(signal));
    } catch (error) {
      if (accountError(error) !== "cancelled") this.publish({ issue: accountError(error) });
    }
  }
  async saveProfile(value: ProfileUpdateRequest) {
    const signal = this.lifetime.signal;
    const cancelled = () => signal.aborted;
    await this.refresh();
    if (cancelled() || this.state.phase !== "account") throw new AccountFailure("cancelled");
    try {
      const profile = await this.api.saveProfile(
        value,
        !this.state.profile?.completed && value.username !== undefined,
        signal,
        this.state.session?.user.id,
      );
      await this.refresh();
      if (cancelled()) throw new AccountFailure("cancelled");
      this.publish({ profile });
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
