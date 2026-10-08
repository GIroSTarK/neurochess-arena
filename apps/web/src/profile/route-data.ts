import { type ProfileResponse, profileUsernameSchema } from "@neurochess/contracts";
import { replace } from "react-router";
import { z } from "zod";

import { accountError } from "../api/auth-client";
import { accountIdSchema } from "../api/identifier-schemas";
import type { AccountActionData, AccountOutcome } from "../auth/action-data";
import { type AccountIntentHandler, sessionActions } from "../auth/session-actions";
import {
  protectedLoader,
  routeAction,
  type RouteActionScope,
  strictFormIntent,
} from "../routing/route-data";
import type { PublicAccess, RouteRuntime, ScopedRouteData } from "../routing/route-runtime";

export type ProfileRouteData = ScopedRouteData<{
  access: PublicAccess;
  profile: ProfileResponse | null;
}>;

export function profileLoader(runtime: RouteRuntime) {
  return protectedLoader(async ({ request }): Promise<ProfileRouteData> => {
    const { generation, access } = await runtime.resolvePublicIdentity(request.signal, false);
    return runtime.result(generation, { access, profile: runtime.account.getSnapshot().profile });
  });
}

export function accountAction(runtime: RouteRuntime) {
  const account = runtime.account;
  return routeAction(
    runtime,
    async ({ request }, scope): Promise<AccountActionData | Response | null> => {
      const entry = runtime.entry(new URL(request.url));
      function mutation<T extends { expectedAccount: string }>(
        schema: z.ZodType<T>,
        perform: (
          input: T,
          scope: RouteActionScope,
        ) => Promise<AccountActionData | Response | null>,
        invalid: (form: FormData) => AccountOutcome = () => ({ error: "AUTH_INVALID_REQUEST" }),
      ): AccountIntentHandler {
        return async (form, scope) => {
          const input = strictFormIntent(form, schema);
          if (!input) return scope.result(invalid(form));
          if (!(await scope.resolveAccount(input.expectedAccount, false))) {
            return scope.result({ error: "AUTH_UNAUTHORIZED" });
          }
          return scope.signal.aborted ? null : perform(input, scope);
        };
      }
      const handlers: Record<string, AccountIntentHandler> = {
        ...sessionActions(runtime),
        "save-profile": mutation(
          z.strictObject({
            intent: z.literal("save-profile"),
            username: profileUsernameSchema,
            expectedAccount: accountIdSchema,
          }),
          async ({ username }, scope) => {
            const onboarding = !account.getSnapshot().profile?.completed;
            await account.saveProfile({ username }, scope.signal);
            if (scope.signal.aborted) return null;
            return onboarding ? replace(entry.returnTo) : scope.result({ notice: "saved" });
          },
          (form) =>
            profileUsernameSchema.safeParse(form.get("username")).success
              ? { error: "AUTH_INVALID_REQUEST" }
              : { invalid: "username" },
        ),
        "remove-avatar": mutation(
          z.strictObject({ intent: z.literal("remove-avatar"), expectedAccount: accountIdSchema }),
          async (_input, scope) => {
            await account.saveProfile({ avatar: "remove" }, scope.signal);
            return scope.signal.aborted ? null : scope.result({ notice: "saved" });
          },
        ),
        "delete-account": mutation(
          z.strictObject({
            intent: z.literal("delete-account"),
            confirm: z.literal("true"),
            expectedAccount: accountIdSchema,
          }),
          async (_input, scope) => {
            await account.deleteAccount(scope.signal);
            scope.useCurrentGeneration();
            const state = account.getSnapshot();
            return scope.signal.aborted
              ? null
              : scope.result(
                  state.deletion === "deleted"
                    ? { notice: "deleted" }
                    : { error: state.issue ?? "AUTH_UNAVAILABLE" },
                );
          },
        ),
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
        return await handler(form, scope);
      } catch (error) {
        const code = accountError(error);
        return scope.signal.aborted || code === "cancelled" ? null : scope.result({ error: code });
      }
    },
  );
}
