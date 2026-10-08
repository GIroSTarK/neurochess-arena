import { replace } from "react-router";

import type { RouteActionScope } from "../app/route-data";
import type { RouteRuntime } from "../app/route-runtime";

import type { AccountActionData } from "./action-data";

export type AccountIntentHandler = (
  form: FormData,
  scope: RouteActionScope,
) => Promise<AccountActionData | Response | null>;

export function sessionActions(runtime: RouteRuntime) {
  const account = runtime.account;
  return {
    guest: async (_form, scope) => {
      const cancelled = () => scope.signal.aborted;
      if (cancelled()) return null;
      await account.chooseGuest();
      return cancelled() ? null : replace("/");
    },
    "sign-out": async (form, scope) => {
      const identity = await scope.resolveAccount(form.get("expectedAccount"), false);
      if (!identity) return scope.result({ error: "AUTH_UNAUTHORIZED" });
      await account.signOut(scope.signal);
      scope.useCurrentGeneration();
      const issue = account.getSnapshot().issue;
      return scope.signal.aborted || !issue ? null : scope.result({ error: issue });
    },
  } satisfies Record<string, AccountIntentHandler>;
}
