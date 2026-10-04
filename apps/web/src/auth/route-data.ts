import {
  authEmailRequestSchema,
  authOAuthProviderSchema,
  authPasswordSchema,
  authSignInRequestSchema,
} from "@neurochess/contracts";
import { type ActionFunctionArgs, type LoaderFunctionArgs, replace } from "react-router";

import { accountError, type AccountErrorCode, AccountFailure } from "../api/auth-client";
import { gameRouteTarget } from "../app/route-navigation";
import type { PublicAccess, RouteRuntime, ScopedRouteData } from "../app/route-runtime";
import type { AuthForm } from "../app/route-urls";

export type PublicRouteData = ScopedRouteData<{ access: PublicAccess }>;
export type AuthOutcome =
  | { notice: "accepted" | "resetDone" }
  | { error: AccountErrorCode }
  | { invalid: "email" | "password" };
export type AuthActionData = ScopedRouteData<AuthOutcome>;

export function publicLoader(runtime: RouteRuntime, requireProfile: boolean, arena = false) {
  return async ({ request, params }: LoaderFunctionArgs): Promise<PublicRouteData | null> => {
    if (arena && gameRouteTarget("arena", new URL(request.url), params.gameId).kind === "invalid") {
      return null;
    }
    try {
      const resolved = await runtime.resolvePublicIdentity(request.signal, requireProfile);
      return runtime.result(resolved.generation, { access: resolved.access });
    } catch (error) {
      if (accountError(error) === "cancelled") return null;
      throw new AccountFailure("AUTH_UNAVAILABLE");
    }
  };
}

export function authAction(runtime: RouteRuntime, kind?: AuthForm) {
  return async ({ request }: ActionFunctionArgs): Promise<AuthActionData | Response | null> => {
    const operation = runtime.beginAction(request.signal);
    const signal = operation.signal;
    const cancelled = () => signal.aborted;
    const entry = runtime.entry(new URL(request.url));
    const account = runtime.account;
    let generation = account.getSnapshot().revision;
    let transitionAttempted = false;
    const result = (data: AuthOutcome) => runtime.result(generation, data);
    try {
      if (request.method !== "POST") return result({ error: "AUTH_INVALID_REQUEST" });
      const data = await request.formData();
      const intent = data.get("intent");
      if (intent !== kind && intent !== "oauth" && intent !== "sign-out" && intent !== "guest") {
        return result({ error: "AUTH_INVALID_REQUEST" });
      }
      if (intent === "guest") {
        if (cancelled()) return null;
        await account.chooseGuest();
        return cancelled() ? null : replace("/");
      }
      const resolved = await runtime.resolvePublicIdentity(signal, false);
      generation = resolved.generation;
      if (intent === "sign-out") {
        if (
          resolved.access !== "account" ||
          data.get("expectedAccount") !== resolved.identity?.expectedAccount
        ) {
          return result({ error: "AUTH_UNAUTHORIZED" });
        }
        await account.signOut(signal);
        generation = account.getSnapshot().revision;
        const issue = account.getSnapshot().issue;
        return cancelled() || !issue ? null : result({ error: issue });
      }
      const api = account.api;
      if (intent === "oauth") {
        const provider = authOAuthProviderSchema.safeParse(data.get("provider"));
        if (!provider.success || (kind !== "sign-in" && kind !== "sign-up")) {
          return result({ error: "AUTH_INVALID_REQUEST" });
        }
        transitionAttempted = true;
        const url = await account.transition(
          (signal) => api.social(provider.data, signal),
          false,
          signal,
        );
        if (!cancelled()) window.location.assign(url);
        return null;
      }
      const emailValue = data.get("email");
      const email = typeof emailValue === "string" ? emailValue.trim() : "";
      const passwordValue = data.get("password");
      const password = typeof passwordValue === "string" ? passwordValue : "";
      if (kind !== "reset-password" && !authEmailRequestSchema.safeParse({ email }).success) {
        return result({ invalid: "email" });
      }
      if (
        ((kind === "sign-up" || kind === "reset-password") &&
          !authPasswordSchema.safeParse(password).success) ||
        (kind === "sign-in" && !authSignInRequestSchema.safeParse({ email, password }).success)
      ) {
        return result({ invalid: "password" });
      }
      if (kind === "sign-in") {
        transitionAttempted = true;
        await account.transition(
          (signal) => api.signIn({ email, password }, signal),
          false,
          signal,
        );
        return cancelled() ? null : replace(entry.returnTo);
      }
      if (kind === "reset-password") {
        const token = entry.readResetToken();
        if (!token) throw new AccountFailure("AUTH_INVALID_TOKEN");
        transitionAttempted = true;
        await account.transition((signal) => api.reset(token, password, signal), false, signal);
        entry.clearResetToken();
        generation = account.getSnapshot().revision;
        return cancelled() ? null : result({ notice: "resetDone" });
      }
      const readSignal = AbortSignal.any([signal, account.identity(false).signal]);
      if (kind === "sign-up") await api.register({ email, password }, readSignal);
      else if (kind === "verify") await api.resend(email, readSignal);
      else if (kind === "forgot-password") await api.forgot(email, readSignal);
      else return result({ error: "AUTH_INVALID_REQUEST" });
      return readSignal.aborted ? null : result({ notice: "accepted" });
    } catch (error) {
      const code = accountError(error);
      if (cancelled() || code === "cancelled") return null;
      if (transitionAttempted) generation = account.getSnapshot().revision;
      return result({ error: code });
    } finally {
      operation.release();
    }
  };
}
