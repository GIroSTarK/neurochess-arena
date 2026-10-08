import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  ShouldRevalidateFunctionArgs,
} from "react-router";
import type { z } from "zod";

import { accountError, AccountFailure } from "../api/auth-client";
import type { AiIdentity } from "../api/identity";

import type { PublicIdentity, RouteRuntime, ScopedRouteData } from "./route-runtime";

export function protectedLoader<T>(load: (args: LoaderFunctionArgs) => Promise<T>) {
  return async (args: LoaderFunctionArgs): Promise<T | null> => {
    try {
      return await load(args);
    } catch (error) {
      if (args.request.signal.aborted || accountError(error) === "cancelled") return null;
      throw new AccountFailure("AUTH_UNAVAILABLE");
    }
  };
}

export function strictFormIntent<T>(form: FormData, schema: z.ZodType<T>): T | null {
  if (new Set(form.keys()).size !== [...form].length) return null;
  const parsed = schema.safeParse(Object.fromEntries(form));
  return parsed.success ? parsed.data : null;
}

export interface RouteActionScope {
  readonly signal: AbortSignal;
  resolveIdentity(requireProfile: boolean): Promise<PublicIdentity>;
  resolveAccount(expectedAccount: unknown, requireProfile: boolean): Promise<AiIdentity | null>;
  useCurrentGeneration(): void;
  result<T>(data: T): ScopedRouteData<T>;
}

export function routeAction<T>(
  runtime: RouteRuntime,
  execute: (args: ActionFunctionArgs, scope: RouteActionScope) => Promise<T>,
) {
  return async (args: ActionFunctionArgs): Promise<T> => {
    const operation = runtime.beginAction(args.request.signal);
    let generation = runtime.account.getSnapshot().revision;
    const resolveIdentity = async (requireProfile: boolean) => {
      const resolved = await runtime.resolvePublicIdentity(operation.signal, requireProfile);
      generation = resolved.generation;
      return resolved;
    };
    try {
      return await execute(args, {
        signal: operation.signal,
        resolveIdentity,
        async resolveAccount(expectedAccount, requireProfile) {
          const { access, identity } = await resolveIdentity(requireProfile);
          return access === "account" && identity?.expectedAccount === expectedAccount
            ? identity
            : null;
        },
        useCurrentGeneration() {
          generation = runtime.account.getSnapshot().revision;
        },
        result: (data) => runtime.result(generation, data),
      });
    } finally {
      operation.release();
    }
  };
}

export function selfPostRevalidation(pathname: string) {
  return (args: ShouldRevalidateFunctionArgs) => {
    // These screens explicitly reconcile confirmed and uncertain writes; an
    // automatic refresh must not let an older loader settle the submission.
    if (
      args.formMethod === "POST" &&
      args.formAction &&
      new URL(args.formAction, args.currentUrl).pathname === pathname
    ) {
      return false;
    }
    return args.defaultShouldRevalidate;
  };
}
