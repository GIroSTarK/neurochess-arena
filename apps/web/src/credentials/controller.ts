import type { CredentialMetadata } from "@neurochess/contracts";

import { type CredentialApi, CredentialFailure } from "./client";

export interface CredentialState {
  credentials: readonly CredentialMetadata[];
  nextCursor: string | null;
  loading: boolean;
  busy: boolean;
  uncertain: boolean;
  issue: CredentialFailure["code"] | "SAVE_UNCERTAIN" | null;
  result: "saved" | "revoked" | "cleared" | null;
}
const emptyState = (): CredentialState => ({
  credentials: [],
  nextCursor: null,
  loading: false,
  busy: false,
  uncertain: false,
  issue: null,
  result: null,
});

export class CredentialController {
  private state = emptyState();
  private readonly listeners = new Set<() => void>();
  private read: AbortController | null = null;
  constructor(
    readonly api: CredentialApi,
    private readonly lifetime: AbortSignal,
    private readonly onUnauthorized: () => void,
  ) {
    lifetime.addEventListener(
      "abort",
      () => {
        this.read?.abort();
        this.publish(emptyState());
      },
      { once: true },
    );
  }
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<CredentialState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private cancelled() {
    return this.lifetime.aborted;
  }
  private failure(error: unknown) {
    const code = error instanceof CredentialFailure ? error.code : "NETWORK";
    if (code === "CREDENTIAL_UNAUTHORIZED") this.onUnauthorized();
    return code;
  }
  readonly refresh = async () => this.load(null);
  readonly more = async () => {
    if (this.state.nextCursor) await this.load(this.state.nextCursor);
  };
  cancelRead() {
    this.read?.abort();
    this.read = null;
  }
  private async load(after: string | null) {
    if (this.cancelled() || this.state.busy || (after && this.state.loading)) return;
    this.read?.abort();
    const request = new AbortController();
    this.read = request;
    const signal = AbortSignal.any([this.lifetime, request.signal]);
    const cancelled = () => signal.aborted;
    this.publish({
      loading: true,
      issue: after && this.state.uncertain ? "SAVE_UNCERTAIN" : null,
      result: null,
    });
    try {
      const page = await this.api.list(after, signal);
      if (cancelled()) return;
      const records = new Map(
        (after ? this.state.credentials : []).map((entry) => [entry.credentialId, entry]),
      );
      page.credentials.forEach((entry) => records.set(entry.credentialId, entry));
      if (page.nextCursor && page.nextCursor === after) {
        throw new CredentialFailure("CREDENTIAL_UNAVAILABLE");
      }
      this.publish({
        credentials: [...records.values()],
        nextCursor: page.nextCursor,
        uncertain: after === null ? false : this.state.uncertain,
      });
    } catch (error) {
      if (!cancelled()) {
        const code = this.failure(error);
        if (!cancelled()) this.publish({ issue: code });
      }
    } finally {
      if (!cancelled()) this.publish({ loading: false });
      if (this.read === request) this.read = null;
    }
  }
  private async mutate(action: "saved" | "revoked" | "cleared", operation: () => Promise<void>) {
    if (this.cancelled() || this.state.busy || (action === "saved" && this.state.uncertain)) {
      return false;
    }
    this.read?.abort();
    this.publish({ busy: true, loading: false, issue: null, result: null });
    try {
      await operation();
      if (this.cancelled()) return false;
      this.publish({ result: action });
      return true;
    } catch (error) {
      if (this.cancelled()) return false;
      const code = this.failure(error);
      if (this.cancelled()) return false;
      const uncertain =
        action === "saved" && (code === "NETWORK" || code === "CREDENTIAL_UNAVAILABLE");
      this.publish({
        issue: uncertain ? "SAVE_UNCERTAIN" : code,
        uncertain: this.state.uncertain || uncertain,
      });
      return false;
    } finally {
      if (!this.cancelled()) this.publish({ busy: false });
    }
  }
  async save(input: unknown) {
    return this.mutate("saved", async () => {
      const record = await this.api.save(input, this.lifetime);
      if (!this.cancelled()) {
        this.publish({ credentials: [record, ...this.state.credentials] });
      }
    });
  }
  async revoke(credentialId: string) {
    return this.mutate("revoked", async () => {
      try {
        await this.api.revoke(credentialId, this.lifetime);
      } catch (error) {
        if (!(error instanceof CredentialFailure && error.code === "CREDENTIAL_NOT_FOUND")) {
          throw error;
        }
      }
      if (!this.cancelled()) {
        this.publish({
          credentials: this.state.credentials.filter(
            (entry) => entry.credentialId !== credentialId,
          ),
        });
      }
    });
  }
  async clear() {
    return this.mutate("cleared", async () => {
      await this.api.clear(this.lifetime);
      if (!this.cancelled()) this.publish({ credentials: [], nextCursor: null });
    });
  }
}
