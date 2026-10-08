import { authOAuthProviderSchema } from "@neurochess/contracts";
import { replace } from "react-router";

import { accountError, AccountFailure } from "../api/auth-client";
import { protectedLoader, routeAction, type RouteActionScope } from "../app/route-data";
import type { PublicAccess, RouteRuntime, ScopedRouteData } from "../app/route-runtime";
import type { AuthForm } from "../app/route-urls";

import type { AccountActionData } from "./action-data";
import { authFormInvalid } from "./form-validation";
import type { AuthEntry } from "./navigation";
import { type AccountIntentHandler, sessionActions } from "./session-actions";

export type PublicRouteData = ScopedRouteData<{ access: PublicAccess }>;
export type AuthActionData = AccountActionData;

export function publicLoader(runtime: RouteRuntime, requireProfile: boolean) {
  return protectedLoader(async ({ request }): Promise<PublicRouteData> => {
    const resolved = await runtime.resolvePublicIdentity(request.signal, requireProfile);
    return runtime.result(resolved.generation, { access: resolved.access });
  });
}

interface AuthFields {
  readonly email: string;
  readonly password: string;
}
type FormHandler = (
  fields: AuthFields,
  scope: RouteActionScope,
  entry: AuthEntry,
) => Promise<AuthActionData | Response | null>;

export function authAction(runtime: RouteRuntime, kind: AuthForm) {
  const account = runtime.account;
  const api = account.api;
  const sessions = sessionActions(runtime);
  async function transition<T>(
    scope: RouteActionScope,
    perform: (signal: AbortSignal) => Promise<T>,
  ) {
    try {
      return await account.transition(perform, false, scope.signal);
    } finally {
      // Transitions intentionally invalidate the submitting generation, including
      // on failure. Their bounded acknowledgement belongs to the settled one.
      scope.useCurrentGeneration();
    }
  }
  const accepted =
    (perform: (fields: AuthFields, signal: AbortSignal) => Promise<unknown>): FormHandler =>
    async (fields, scope) => {
      const signal = AbortSignal.any([scope.signal, account.identity(false).signal]);
      await perform(fields, signal);
      return signal.aborted ? null : scope.result({ notice: "accepted" });
    };
  const forms: Record<AuthForm, FormHandler> = {
    "sign-in": async ({ email, password }, scope, entry) => {
      await transition(scope, (signal) => api.signIn({ email, password }, signal));
      return scope.signal.aborted ? null : replace(entry.returnTo);
    },
    "sign-up": accepted(({ email, password }, signal) => api.register({ email, password }, signal)),
    verify: accepted(({ email }, signal) => api.resend(email, signal)),
    "forgot-password": accepted(({ email }, signal) => api.forgot(email, signal)),
    "reset-password": async ({ password }, scope, entry) => {
      const token = entry.readResetToken();
      if (!token) throw new AccountFailure("AUTH_INVALID_TOKEN");
      await transition(scope, (signal) => api.reset(token, password, signal));
      entry.clearResetToken();
      return scope.signal.aborted ? null : scope.result({ notice: "resetDone" });
    },
  };
  const oauth: AccountIntentHandler = async (form, scope) => {
    const provider = authOAuthProviderSchema.safeParse(form.get("provider"));
    if (!provider.success || (kind !== "sign-in" && kind !== "sign-up")) {
      return scope.result({ error: "AUTH_INVALID_REQUEST" });
    }
    const url = await transition(scope, (signal) => api.social(provider.data, signal));
    if (!scope.signal.aborted) window.location.assign(url);
    return null;
  };
  return routeAction(
    runtime,
    async ({ request }, scope): Promise<AuthActionData | Response | null> => {
      const entry = runtime.entry(new URL(request.url));
      const handlers: Record<string, AccountIntentHandler> = {
        ...sessions,
        oauth,
        [kind]: async (form, scope) => {
          const email = form.get("email");
          const password = form.get("password");
          const fields = {
            email: typeof email === "string" ? email.trim() : "",
            password: typeof password === "string" ? password : "",
          };
          const invalid = authFormInvalid(kind, fields.email, fields.password);
          return invalid ? scope.result({ invalid }) : forms[kind](fields, scope, entry);
        },
      };
      try {
        if (request.method !== "POST") return scope.result({ error: "AUTH_INVALID_REQUEST" });
        const form = await request.formData();
        const intent = form.get("intent");
        const handler =
          typeof intent === "string" && Object.hasOwn(handlers, intent)
            ? handlers[intent]
            : undefined;
        if (!handler) {
          return scope.result({ error: "AUTH_INVALID_REQUEST" });
        }
        if (intent !== "guest" && intent !== "sign-out") await scope.resolveIdentity(false);
        return await handler(form, scope);
      } catch (error) {
        const code = accountError(error);
        return scope.signal.aborted || code === "cancelled" ? null : scope.result({ error: code });
      }
    },
  );
}
