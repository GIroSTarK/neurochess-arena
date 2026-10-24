import { credentialSaveRequestSchema } from "@neurochess/contracts";
import { z } from "zod";

import {
  createCredentialApi,
  credentialError,
  type CredentialFailure,
} from "../api/credential-client";
import { accountIdSchema, credentialIdSchema } from "../api/identifier-schemas";
import { FencedResults } from "../routing/fenced-results";
import type { AppRouteContext } from "../routing/route-context";
import {
  protectedLoader,
  routeAction,
  selfPostRevalidation,
  strictFormIntent,
} from "../routing/route-data";
import {
  type PublicAccess,
  type ScopedRouteData,
  waitForRouteResult,
} from "../routing/route-runtime";

import { type CredentialCatalogState, notifyCredentialChange } from "./catalog";

export type CredentialRouteData = ScopedRouteData<{
  access: PublicAccess;
  catalog: CredentialCatalogState | null;
}>;
export type CredentialOutcome =
  { success: "saved" | "revoked" | "cleared" } | { error: CredentialFailure["code"] };
export type CredentialActionData = ScopedRouteData<CredentialOutcome>;
const intentSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("save"),
    expectedAccount: accountIdSchema,
    credentialId: credentialIdSchema,
    save: z.literal("true"),
    provider: z.string(),
    label: z.string(),
    apiKey: z.string(),
  }),
  z.strictObject({
    intent: z.literal("revoke"),
    credentialId: credentialIdSchema,
    expectedAccount: accountIdSchema,
    confirm: z.literal("true"),
  }),
  z.strictObject({
    intent: z.literal("clear"),
    expectedAccount: accountIdSchema,
    confirm: z.literal("true"),
  }),
]);

export function credentialRouteData({
  apiBaseUrl,
  runtime,
}: Pick<AppRouteContext, "apiBaseUrl" | "runtime">) {
  const catalogs = new FencedResults<NonNullable<CredentialRouteData["data"]>>((data) => {
    data.catalog = null;
  });
  const loader = protectedLoader(async ({ request }): Promise<CredentialRouteData | null> => {
    const read = catalogs.beginRead();
    const { generation, access, identity } = await runtime.resolvePublicIdentity(
      request.signal,
      false,
    );
    const result = (catalog: CredentialCatalogState | null) => {
      return read(runtime.publicResult(generation, { access, catalog }));
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
  });
  const action = routeAction(
    runtime,
    async ({ request }, scope): Promise<CredentialActionData | null> => {
      const result = (outcome: CredentialOutcome) => scope.result(outcome);
      let dispatched = false;
      try {
        if (request.method !== "POST") return result({ error: "CREDENTIAL_INVALID_REQUEST" });
        const form = await request.formData();
        const input = strictFormIntent(form, intentSchema);
        if (!input) {
          return result({ error: "CREDENTIAL_INVALID_REQUEST" });
        }
        const identity = await scope.resolveAccount(input.expectedAccount, false);
        if (!identity) {
          return result({ error: "CREDENTIAL_UNAUTHORIZED" });
        }
        const signal = AbortSignal.any([scope.signal, identity.signal]);
        const cancelled = () => signal.aborted;
        if (cancelled()) return null;
        const api = createCredentialApi(apiBaseUrl, identity);
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
        catalogs.invalidate(input.intent !== "save");
        return result({
          success:
            input.intent === "save" ? "saved" : input.intent === "revoke" ? "revoked" : "cleared",
        });
      } catch (error) {
        return scope.signal.aborted ? null : result({ error: credentialError(error) });
      } finally {
        if (dispatched) notifyCredentialChange();
      }
    },
  );
  const shouldRevalidate = selfPostRevalidation("/account/credentials");
  return { loader, action, shouldRevalidate };
}
