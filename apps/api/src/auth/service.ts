import { AsyncLocalStorage } from "node:async_hooks";

import { authResetPasswordRequestSchema, authSignInRequestSchema } from "@neurochess/contracts";
import {
  createAuthDatabaseAdapter,
  type DatabaseConnection,
  withAuthUserLock,
} from "@neurochess/database";
import { betterAuth } from "better-auth/minimal";
import { z } from "zod";

import type { AccountPrincipal } from "../identity/principal.js";

import type { AuthEmail, AuthEmailSender } from "./email.js";
import { AUTH_BASE_PATH, type AuthEnvironment, authOptions } from "./options.js";

export interface AccountAuth {
  readonly baseURL: string;
  readonly emailEnabled?: boolean;
  handle(request: Request): Promise<Response>;
  resolve(headers: Headers): Promise<AccountPrincipal | null>;
}

export function createAccountAuth(
  database: DatabaseConnection,
  environment: AuthEnvironment,
  sender?: AuthEmailSender,
): AccountAuth {
  const delivery = new AsyncLocalStorage<AuthEmail[]>();
  const bufferedSender: AuthEmailSender | undefined = sender
    ? {
        async send(message) {
          const pending = delivery.getStore();
          if (!pending) throw new Error("Authentication delivery scope is unavailable");
          pending.push(message);
        },
      }
    : undefined;
  const options = authOptions(environment, bufferedSender);
  const createAuth = (adapter: ReturnType<typeof createAuthDatabaseAdapter>) =>
    betterAuth({
      ...options,
      database: adapter,
    });
  const auth = createAuth(createAuthDatabaseAdapter(database));
  const getSession = (headers: Headers) =>
    auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });

  async function handleRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    let userId: string | undefined;
    if (
      sender &&
      request.method === "POST" &&
      (path === `${AUTH_BASE_PATH}/sign-in/email` || path === `${AUTH_BASE_PATH}/reset-password`)
    ) {
      const body: unknown = await request.clone().json();
      const context = await auth.$context;
      if (path === `${AUTH_BASE_PATH}/sign-in/email`) {
        const parsed = authSignInRequestSchema.safeParse(body);
        if (parsed.success) {
          userId = (await context.internalAdapter.findUserByEmail(parsed.data.email))?.user.id;
        }
      } else {
        const parsed = authResetPasswordRequestSchema.safeParse(body);
        if (parsed.success) {
          userId = (
            await context.internalAdapter.findVerificationValue(
              `reset-password:${parsed.data.token}`,
            )
          )?.value;
        }
      }
    }
    if (!userId) return auth.handler(request);
    try {
      return await withAuthUserLock(database, z.uuid().parse(userId), async (adapter) => {
        const response = await createAuth(adapter).handler(request);
        // The library converts adapter errors into responses. Roll back password,
        // token and session changes together when it reports a server failure.
        if (response.status >= 500) throw new AuthTransactionFailure(response);
        return response;
      });
    } catch (error) {
      if (error instanceof AuthTransactionFailure) return error.response;
      throw error;
    }
  }

  return {
    baseURL: environment.BETTER_AUTH_URL,
    emailEnabled: Boolean(sender),
    async handle(request) {
      const pending: AuthEmail[] = [];
      const response = await delivery.run(pending, () => handleRequest(request));
      // Registration invokes mail callbacks inside its transaction and catches
      // callback failures. Dispatch only after commit, then acknowledge delivery.
      if (response.ok && sender) {
        try {
          for (const message of pending) await sender.send(message);
        } catch {
          return Response.json({ code: "AUTH_EMAIL_UNAVAILABLE" }, { status: 503 });
        }
      }
      // Better Auth's sign-out catches adapter deletion errors. Never acknowledge
      // revocation while the same server-side session can still authenticate.
      if (
        new URL(request.url).pathname === `${AUTH_BASE_PATH}/sign-out` &&
        response.ok &&
        (await getSession(request.headers))
      ) {
        throw new Error("Session revocation failed");
      }
      return response;
    },
    async resolve(headers) {
      const value = await getSession(headers);
      return value ? { kind: "account", userId: z.uuid().parse(value.user.id) } : null;
    },
  };
}

class AuthTransactionFailure extends Error {
  constructor(readonly response: Response) {
    super("Authentication transaction failed");
  }
}
