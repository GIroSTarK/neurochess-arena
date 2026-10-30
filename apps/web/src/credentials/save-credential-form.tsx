import { aiProviderSchema, credentialSaveRequestSchema } from "@neurochess/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";

import type { CredentialFailure } from "../api/credential-client";
import type { PublicIdentity } from "../api/identity";
import { AccountField } from "../auth/account-field";
import { PasswordField } from "../auth/password-field";
import { Button } from "../ui/button";
import { Select } from "../ui/select";

import type { CredentialCatalogState } from "./catalog";
import type { CredentialActionData, CredentialOutcome } from "./route-data";

type SaveFeedback =
  { status: "none" | "saved" } | { status: "error"; code: CredentialFailure["code"] };
interface UnresolvedSave {
  id: string;
  after: number;
  phase: "awaiting-metadata" | "retryable";
}
type SaveAttempt =
  | { phase: "idle" | "settled"; feedback: SaveFeedback; unresolved: UnresolvedSave | null }
  | { phase: "submitting" | "settling"; id: string; unresolved: UnresolvedSave | null };
type SaveAttemptEvent =
  | { type: "invalid" | "submission-finished" | "clear" }
  | { type: "submit"; id: string }
  | { type: "acknowledge"; outcome: CredentialOutcome | null | undefined; version: number }
  | { type: "metadata"; catalog: CredentialCatalogState; version: number };

const emptyAttempt: SaveAttempt = {
  phase: "idle",
  feedback: { status: "none" },
  unresolved: null,
};

function reduceSaveAttempt(state: SaveAttempt, event: SaveAttemptEvent): SaveAttempt {
  switch (event.type) {
    case "clear":
      return emptyAttempt;
    case "invalid":
      if (state.phase !== "idle" && state.phase !== "settled") return state;
      return { ...state, feedback: { status: "error", code: "CREDENTIAL_INVALID_REQUEST" } };
    case "submit":
      if (
        (state.phase !== "idle" && state.phase !== "settled") ||
        state.unresolved?.phase === "awaiting-metadata"
      ) {
        return state;
      }
      return {
        phase: "submitting",
        id: state.unresolved?.id ?? event.id,
        unresolved: state.unresolved,
      };
    case "submission-finished":
      return state.phase === "submitting" ? { ...state, phase: "settling" } : state;
    case "acknowledge": {
      if (state.phase !== "settling") return state;
      if (event.outcome && "success" in event.outcome) {
        return { phase: "settled", feedback: { status: "saved" }, unresolved: null };
      }
      // Cancellation provides no acknowledgement, even when the API already committed.
      const code = event.outcome?.error ?? "CREDENTIAL_UNAVAILABLE";
      return {
        phase: "settled",
        feedback: { status: "error", code },
        unresolved:
          code === "CREDENTIAL_UNAVAILABLE" || code === "CREDENTIAL_CONFLICT"
            ? { id: state.id, after: event.version, phase: "awaiting-metadata" }
            : state.unresolved,
      };
    }
    case "metadata": {
      if (
        (state.phase !== "idle" && state.phase !== "settled") ||
        !state.unresolved ||
        event.catalog.phase !== "ready" ||
        event.version <= state.unresolved.after
      ) {
        return state;
      }
      if (event.catalog.credentials.some((item) => item.credentialId === state.unresolved?.id)) {
        return {
          ...state,
          unresolved: null,
          feedback:
            state.feedback.status === "error" && state.feedback.code === "CREDENTIAL_CONFLICT"
              ? state.feedback
              : { status: "saved" },
        };
      }
      // Absence cannot rule out a late commit. Only an explicit retry may reuse this ID.
      return state.unresolved.phase === "awaiting-metadata"
        ? { ...state, unresolved: { ...state.unresolved, phase: "retryable" } }
        : state;
    }
  }
}

export function SaveCredentialForm({
  identity,
  catalog,
  version,
  refresh,
}: {
  readonly identity: PublicIdentity;
  readonly catalog: CredentialCatalogState;
  readonly version: number;
  readonly refresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const providerId = useId();
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef<symbol | null>(null);
  const mutation = useFetcher<CredentialActionData | null>();
  const reset = mutation.reset;
  const busy = mutation.state !== "idle";
  const [consent, setConsent] = useState(false);
  const [attempt, setAttempt] = useState<SaveAttempt>(emptyAttempt);
  const reconciling = attempt.unresolved?.phase === "awaiting-metadata";
  const feedback =
    attempt.phase === "idle" || attempt.phase === "settled" ? attempt.feedback : null;
  const error = feedback?.status === "error" ? feedback.code : null;
  const saved = feedback?.status === "saved";
  const settled = attempt.phase === "settled";
  const outcome = mutation.data?.data;
  if (!busy) {
    const next = reduceSaveAttempt(
      attempt,
      attempt.phase === "settling"
        ? { type: "acknowledge", outcome, version }
        : { type: "metadata", catalog, version },
    );
    if (next !== attempt) setAttempt(next);
  }
  useEffect(() => {
    if (settled) void refresh();
  }, [settled, refresh]);
  useEffect(() => {
    const element = form.current;
    const clear = () => {
      element?.reset();
      reset();
      pending.current = null;
      setConsent(false);
      setAttempt((state) => reduceSaveAttempt(state, { type: "clear" }));
    };
    window.addEventListener("pagehide", clear);
    identity.signal.addEventListener("abort", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      identity.signal.removeEventListener("abort", clear);
      // An unmount has already detached the form, so scrub the key it may still hold.
      // StrictMode's dev replay keeps it connected; resetting then would erase entered input.
      if (!element?.isConnected) clear();
      else reset();
    };
  }, [identity.signal, reset]);
  function save() {
    if (
      !form.current ||
      busy ||
      pending.current ||
      !consent ||
      reconciling ||
      identity.signal.aborted ||
      !identity.expectedAccount
    ) {
      return;
    }
    const data = new FormData(form.current);
    const id = attempt.unresolved?.id ?? crypto.randomUUID();
    const input = credentialSaveRequestSchema.safeParse({
      credentialId: id,
      provider: data.get("provider"),
      label: data.get("label"),
      apiKey: data.get("apiKey"),
      save: true,
    });
    if (!input.success) {
      setAttempt((state) => reduceSaveAttempt(state, { type: "invalid" }));
      return;
    }
    data.set("intent", "save");
    data.set("save", "true");
    data.set("credentialId", id);
    data.set("expectedAccount", identity.expectedAccount);
    form.current.reset();
    setConsent(false);
    setAttempt((state) => reduceSaveAttempt(state, { type: "submit", id }));
    const submission = Symbol();
    pending.current = submission;
    reset();
    void mutation.submit(data, { method: "post", action: "/account/credentials" }).finally(() => {
      if (pending.current !== submission || identity.signal.aborted) return;
      pending.current = null;
      setAttempt((state) => reduceSaveAttempt(state, { type: "submission-finished" }));
    });
  }
  return (
    <mutation.Form
      method="post"
      action="/account/credentials"
      ref={form}
      className="grid w-full max-w-xl min-w-0 gap-4 rounded-panel border border-divider bg-surface p-4 @min-[32rem]/page:p-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h2 className="text-section font-semibold">{t("credentials.add")}</h2>
      <div className="grid gap-2 text-label">
        <label htmlFor={providerId}>{t("setup.provider")}</label>
        <Select id={providerId} name="provider" defaultValue="openai" disabled={busy}>
          {aiProviderSchema.options.map((provider) => (
            <option key={provider} value={provider}>
              {t(`setup.providers.${provider}`)}
            </option>
          ))}
        </Select>
      </div>
      <AccountField
        name="label"
        label={t("credentials.label")}
        maxLength={64}
        readOnly={busy}
        autoComplete="off"
        hint={t("credentials.labelHint")}
      />
      <PasswordField
        name="apiKey"
        label={t("setup.apiKey")}
        maxLength={4096}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        readOnly={busy}
        showLabel={t("setup.showKey")}
        hideLabel={t("setup.hideKey")}
      />
      <p className="text-body text-text-secondary">{t("credentials.persistence")}</p>
      <label className="flex min-h-target items-center gap-3 text-label">
        <input
          type="checkbox"
          className="size-5 shrink-0 accent-accent"
          checked={consent}
          disabled={busy}
          onChange={(event) => setConsent(event.currentTarget.checked)}
        />
        {t("credentials.saveOptIn")}
      </label>
      {error ? (
        <p role="alert" className="text-danger">
          {t(`credentials.errors.${error}`)}
        </p>
      ) : null}
      {saved ? <p role="status">{t("credentials.saved")}</p> : null}
      <Button type="submit" variant="primary" aria-disabled={busy || !consent || reconciling}>
        {t(busy ? "account.working" : "credentials.save")}
      </Button>
    </mutation.Form>
  );
}
