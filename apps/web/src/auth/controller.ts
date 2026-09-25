import type { AuthSessionResponse, ProfileResponse } from "@neurochess/contracts";

import { type AccountApi, AccountFailure } from "./client";
import { navigateAccount } from "./navigation";

type Session = AuthSessionResponse["session"];
export interface AccountState {
  phase: "checking" | "ready" | "ended" | "error";
  session: Session;
  profile: ProfileResponse | null;
  epoch: number;
  issue: AccountFailure["code"] | null;
}
const contextKey = "neurochess.account-context";
const changeKey = "neurochess.identity-change";
function accountContext() {
  try {
    return localStorage.getItem(contextKey) === "account";
  } catch {
    return false;
  }
}
function rememberContext(account: boolean) {
  // Only a context marker is persisted, never an identity, private data, or credentials.
  try {
    localStorage.setItem(contextKey, account ? "account" : "guest");
  } catch {
    /* Storage can be disabled. */
  }
}

export class AccountController {
  private state: AccountState = {
    phase: "checking",
    session: null,
    profile: null,
    epoch: 0,
    issue: null,
  };
  private readonly listeners = new Set<() => void>();
  private scope = new AbortController();
  private read: AbortController | null = null;
  private mutation: AbortController | null = null;
  private interval: ReturnType<typeof setInterval> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private connected = false;
  private changing = false;
  private expectedAccount = accountContext();
  constructor(readonly api: AccountApi) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get signal() {
    return this.scope.signal;
  }
  private publish(update: Partial<AccountState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private invalidate(phase: AccountState["phase"] = "checking", preserveRead = false) {
    this.scope.abort();
    if (!preserveRead) {
      this.read?.abort();
      this.read = null;
    }
    clearTimeout(this.expiry);
    this.scope = new AbortController();
    this.publish({ phase, session: null, profile: null, epoch: this.state.epoch + 1, issue: null });
  }
  private broadcast() {
    try {
      localStorage.setItem(changeKey, crypto.randomUUID());
    } catch {
      /* Focus/polling remain available. */
    }
  }
  readonly beginChange = (phase: AccountState["phase"] = "ended") => {
    this.changing = true;
    this.expectedAccount = true;
    rememberContext(true);
    this.invalidate(phase);
    this.broadcast();
  };
  readonly changed = async () => {
    this.changing = false;
    this.broadcast();
    await this.check();
  };
  readonly expired = () => {
    this.expectedAccount = true;
    rememberContext(true);
    this.invalidate("ended");
  };
  private readonly storage = (event: StorageEvent) => {
    if (event.key !== changeKey && event.key !== contextKey) return;
    this.changing = false;
    this.expectedAccount ||= accountContext() || this.state.session !== null;
    this.invalidate();
    void this.check();
  };
  private readonly focus = () => {
    if (document.visibilityState !== "hidden") void this.check();
  };
  private readonly pagehide = () => {
    this.changing = false;
    this.mutation?.abort();
    this.invalidate();
  };
  private readonly pageshow = (event: PageTransitionEvent) => {
    if (event.persisted) void this.check();
  };
  connect() {
    this.connected = true;
    window.addEventListener("storage", this.storage);
    window.addEventListener("focus", this.focus);
    document.addEventListener("visibilitychange", this.focus);
    window.addEventListener("pagehide", this.pagehide);
    window.addEventListener("pageshow", this.pageshow);
    this.interval = setInterval(this.focus, 30_000);
    void this.check();
    return () => {
      this.connected = false;
      clearInterval(this.interval);
      window.removeEventListener("storage", this.storage);
      window.removeEventListener("focus", this.focus);
      document.removeEventListener("visibilitychange", this.focus);
      window.removeEventListener("pagehide", this.pagehide);
      window.removeEventListener("pageshow", this.pageshow);
      this.mutation?.abort();
      this.invalidate();
    };
  }
  readonly check = async () => {
    if (!this.connected || this.changing || this.mutation || this.read) return;
    const request = new AbortController();
    const cancelled = () => request.signal.aborted || !this.connected;
    this.read = request;
    try {
      const { session } = await this.api.session(request.signal);
      if (cancelled()) return;
      if (!session) {
        const ended = this.expectedAccount || this.state.session !== null || accountContext();
        if (this.state.session || this.state.phase !== (ended ? "ended" : "ready")) {
          this.invalidate(ended ? "ended" : "ready");
        }
        return;
      }
      this.expectedAccount = true;
      rememberContext(true);
      if (this.state.session?.user.id === session.user.id && this.state.phase === "ready") {
        this.publish({ session });
      } else {
        // Fence the old identity before its replacement's private profile is requested.
        this.invalidate("checking", true);
        const scope = this.scope.signal;
        const profile = await this.api.profile(AbortSignal.any([scope, request.signal]));
        if (scope.aborted || cancelled()) return;
        this.publish({ phase: "ready", session, profile });
      }
      clearTimeout(this.expiry);
      this.expiry = setTimeout(
        this.expired,
        Math.max(0, Math.min(2_147_483_647, Date.parse(session.expiresAt) - Date.now())),
      );
    } catch (error) {
      if (cancelled()) return;
      this.invalidate(
        error instanceof AccountFailure &&
          ["AUTH_UNAUTHORIZED", "PROFILE_UNAUTHORIZED"].includes(error.code)
          ? "ended"
          : "error",
      );
      this.publish({ issue: error instanceof AccountFailure ? error.code : "NETWORK" });
    } finally {
      if (this.read === request) this.read = null;
    }
  };
  setProfile(profile: ProfileResponse, signal: AbortSignal) {
    if (!signal.aborted && signal === this.scope.signal) this.publish({ profile });
  }
  async signOut(guest = false) {
    if (this.mutation) return;
    this.beginChange("checking");
    const request = new AbortController();
    this.mutation = request;
    try {
      await this.api.signOut(request.signal);
      if (request.signal.aborted) return;
      this.expectedAccount = !guest;
      rememberContext(!guest);
      this.invalidate(guest ? "ready" : "ended");
      this.broadcast();
      navigateAccount("/");
    } catch (error) {
      if (!request.signal.aborted) {
        this.publish({
          phase: "error",
          issue: error instanceof AccountFailure ? error.code : "NETWORK",
        });
      }
    } finally {
      if (this.mutation === request) this.mutation = null;
      this.changing = false;
    }
  }
}
