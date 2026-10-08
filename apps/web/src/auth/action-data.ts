import type { AccountErrorCode } from "../api/auth-client";
import type { ScopedRouteData } from "../app/route-runtime";

export type AccountOutcome =
  | { notice: "accepted" | "resetDone" | "saved" | "deleted" }
  | { error: AccountErrorCode }
  | { invalid: "email" | "password" | "username" };
export type AccountActionData = ScopedRouteData<AccountOutcome>;
