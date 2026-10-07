import {
  authOAuthProviderSchema,
  gameParamsSchema,
  type ProfileResponse,
  profileUsernameSchema,
} from "@neurochess/contracts";
import { type ActionFunctionArgs, type LoaderFunctionArgs, replace } from "react-router";
import { z } from "zod";

import { accountError, type AccountErrorCode, AccountFailure } from "../api/auth-client";
import type { PublicAccess, RouteRuntime, ScopedRouteData } from "../app/route-runtime";
import type { AuthForm } from "../app/route-urls";

import { authFormInvalid } from "./form-validation";

export type PublicRouteData = ScopedRouteData<{ access: PublicAccess }>;
export type ProfileRouteData = ScopedRouteData<{
  access: PublicAccess;
  profile: ProfileResponse | null;
}>;
export type AuthOutcome =
  | { notice: "accepted" | "resetDone" | "saved" | "deleted" }
  | { error: AccountErrorCode }
  | { invalid: "email" | "password" | "username" };
export type AuthActionData = ScopedRouteData<AuthOutcome>;

const expectedAccount = gameParamsSchema.shape.gameId;
const accountIntent = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("save-profile"),
    username: profileUsernameSchema,
    expectedAccount,
  }),
  z.strictObject({ intent: z.literal("remove-avatar"), expectedAccount }),
  z.strictObject({
    intent: z.literal("delete-account"),
    confirm: z.literal("true"),
    expectedAccount,
  }),
]);

export function profileLoader(runtime: RouteRuntime) {
  return async ({ request }: LoaderFunctionArgs): Promise<ProfileRouteData | null> => {
    try {
      const { generation, access } = await runtime.resolvePublicIdentity(request.signal, false);
      return runtime.result(generation, { access, profile: runtime.account.getSnapshot().profile });
    } catch (error) {
      if (accountError(error) === "cancelled") return null;
      throw new AccountFailure("AUTH_UNAVAILABLE");
    }
  };
}

export function publicLoader(runtime: RouteRuntime, requireProfile: boolean) {
  return async ({ request }: LoaderFunctionArgs): Promise<PublicRouteData | null> => {
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
      if (
        !kind &&
        (intent === "save-profile" || intent === "remove-avatar" || intent === "delete-account")
      ) {
        const parsed = accountIntent.safeParse(Object.fromEntries(data));
        if (!parsed.success || new Set(data.keys()).size !== [...data].length) {
          return result(
            intent === "save-profile" &&
              !profileUsernameSchema.safeParse(data.get("username")).success
              ? { invalid: "username" }
              : { error: "AUTH_INVALID_REQUEST" },
          );
        }
        const resolved = await runtime.resolvePublicIdentity(signal, false);
        generation = resolved.generation;
        if (
          resolved.access !== "account" ||
          parsed.data.expectedAccount !== resolved.identity?.expectedAccount
        ) {
          return result({ error: "AUTH_UNAUTHORIZED" });
        }
        if (cancelled()) return null;
        if (parsed.data.intent === "delete-account") {
          await account.deleteAccount(signal);
          generation = account.getSnapshot().revision;
          const state = account.getSnapshot();
          return cancelled()
            ? null
            : result(
                state.deletion === "deleted"
                  ? { notice: "deleted" }
                  : { error: state.issue ?? "AUTH_UNAVAILABLE" },
              );
        }
        const onboarding = !account.getSnapshot().profile?.completed;
        await account.saveProfile(
          parsed.data.intent === "remove-avatar"
            ? { avatar: "remove" }
            : { username: parsed.data.username },
          signal,
        );
        if (cancelled()) return null;
        if (onboarding && parsed.data.intent === "save-profile") return replace(entry.returnTo);
        return result({ notice: "saved" });
      }
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
      if (!kind) return result({ error: "AUTH_INVALID_REQUEST" });
      const invalid = authFormInvalid(kind, email, password);
      if (invalid) return result({ invalid });
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
      else await api.forgot(email, readSignal);
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
