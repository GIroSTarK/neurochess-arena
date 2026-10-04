import { credentialSaveRequestSchema, gameParamsSchema } from "@neurochess/contracts";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import { z } from "zod";

import { accountError, AccountFailure } from "../api/auth-client";
import {
  createCredentialApi,
  credentialError,
  type CredentialFailure,
} from "../api/credential-client";
import type { AppRouteContext } from "../app/route-context";
import { type PublicAccess, type ScopedRouteData, waitForRouteResult } from "../app/route-runtime";

import { type CredentialCatalogState, notifyCredentialChange } from "./catalog";

export type CredentialRouteData = ScopedRouteData<{
  access: PublicAccess;
  catalog: CredentialCatalogState | null;
}>;
export type CredentialOutcome =
  { success: "saved" | "revoked" | "cleared" } | { error: CredentialFailure["code"] };
export type CredentialActionData = ScopedRouteData<CredentialOutcome>;
const expectedAccount = gameParamsSchema.shape.gameId;
const intentSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("save"),
    expectedAccount,
    credentialId: gameParamsSchema.shape.gameId,
    save: z.literal("true"),
    provider: z.string(),
    label: z.string(),
    apiKey: z.string(),
  }),
  z.strictObject({
    intent: z.literal("revoke"),
    credentialId: gameParamsSchema.shape.gameId,
    expectedAccount,
    confirm: z.literal("true"),
  }),
  z.strictObject({ intent: z.literal("clear"), expectedAccount, confirm: z.literal("true") }),
]);

export function credentialRouteData({
  apiBaseUrl,
  runtime,
}: Pick<AppRouteContext, "apiBaseUrl" | "runtime">) {
  const catalogs = new Set<WeakRef<CredentialRouteData>>();
  let revision = 0;
  const loader = async ({ request }: LoaderFunctionArgs): Promise<CredentialRouteData | null> => {
    const readRevision = revision;
    try {
      const { generation, access, identity } = await runtime.resolvePublicIdentity(
        request.signal,
        false,
      );
      const result = (catalog: CredentialCatalogState | null) => {
        const scoped = runtime.result(generation, {
          access,
          catalog: readRevision === revision ? catalog : null,
        });
        for (const reference of catalogs) if (!reference.deref()) catalogs.delete(reference);
        catalogs.add(new WeakRef(scoped));
        return scoped;
      };
      if (access !== "account" || !identity) return result(null);
      const signal = AbortSignal.any([request.signal, identity.signal]);
      try {
        const metadata = await waitForRouteResult(
          createCredentialApi(apiBaseUrl, identity).list(signal),
          signal,
        );
        return request.signal.aborted
          ? null
          : result(signal.aborted ? null : { phase: "ready", credentials: metadata.credentials });
      } catch {
        return request.signal.aborted
          ? null
          : result(signal.aborted ? null : { phase: "error", credentials: [] });
      }
    } catch (error) {
      if (request.signal.aborted || accountError(error) === "cancelled") return null;
      throw new AccountFailure("AUTH_UNAVAILABLE");
    }
  };
  const action = async ({ request }: ActionFunctionArgs): Promise<CredentialActionData | null> => {
    const operation = runtime.beginAction(request.signal);
    let generation = runtime.account.getSnapshot().revision;
    const result = (outcome: CredentialOutcome) => runtime.result(generation, outcome);
    let dispatched = false;
    try {
      if (request.method !== "POST") return result({ error: "CREDENTIAL_INVALID_REQUEST" });
      const form = await request.formData();
      const parsed = intentSchema.safeParse(Object.fromEntries(form));
      if (!parsed.success || new Set(form.keys()).size !== [...form].length) {
        return result({ error: "CREDENTIAL_INVALID_REQUEST" });
      }
      const resolved = await runtime.resolvePublicIdentity(operation.signal, false);
      generation = resolved.generation;
      const { identity } = resolved;
      if (
        resolved.access !== "account" ||
        parsed.data.expectedAccount !== identity?.expectedAccount
      ) {
        return result({ error: "CREDENTIAL_UNAUTHORIZED" });
      }
      const signal = AbortSignal.any([operation.signal, identity.signal]);
      const cancelled = () => signal.aborted;
      if (cancelled()) return null;
      const api = createCredentialApi(apiBaseUrl, identity);
      const input = parsed.data;
      if (input.intent === "save") {
        const value = credentialSaveRequestSchema.safeParse({
          credentialId: input.credentialId,
          provider: input.provider,
          label: input.label,
          apiKey: input.apiKey,
          save: true,
        });
        if (!value.success) return result({ error: "CREDENTIAL_INVALID_REQUEST" });
        dispatched = true;
        await api.save(value.data, signal);
      } else {
        dispatched = true;
        if (input.intent === "revoke") await api.revoke(input.credentialId, signal);
        else await api.clear(signal);
      }
      if (cancelled()) return null;
      // A pre-mutation read cannot restore deleted metadata after an unsuccessful refresh.
      revision++;
      if (input.intent !== "save") {
        for (const reference of catalogs) {
          const catalog = reference.deref();
          if (catalog?.data) catalog.data.catalog = null;
        }
        catalogs.clear();
      }
      return result({
        success:
          input.intent === "save" ? "saved" : input.intent === "revoke" ? "revoked" : "cleared",
      });
    } catch (error) {
      return operation.signal.aborted ? null : result({ error: credentialError(error) });
    } finally {
      if (dispatched) notifyCredentialChange();
      operation.release();
    }
  };
  const shouldRevalidate = (args: ShouldRevalidateFunctionArgs) => {
    // Forms reconcile through a fresh, resettable metadata fetcher. Failed writes
    // never cause an automatic mutation retry or settle from an older loader.
    if (
      args.formMethod === "POST" &&
      args.formAction &&
      new URL(args.formAction, args.currentUrl).pathname === "/account/credentials"
    ) {
      return false;
    }
    return args.defaultShouldRevalidate;
  };
  return { loader, action, shouldRevalidate };
}
