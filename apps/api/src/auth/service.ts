import { AsyncLocalStorage } from "node:async_hooks";

import {
  type AuthOAuthProvider,
  authResetPasswordRequestSchema,
  authSignInRequestSchema,
} from "@neurochess/contracts";
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
  readonly oauthProviders?: readonly AuthOAuthProvider[];
  handle(request: Request, onEmailDeliveryFailure?: () => void): Promise<Response>;
  resolve(headers: Headers): Promise<AccountPrincipal | null>;
  close?(): Promise<void>;
}

export function createAccountAuth(
  database: DatabaseConnection,
  environment: AuthEnvironment,
  sender?: AuthEmailSender,
): AccountAuth {
  const delivery = new AsyncLocalStorage<AuthEmail[]>();
  const pendingDeliveries = new Set<Promise<void>>();
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

  async function deliverEmails(messages: AuthEmail[], onFailure?: () => void): Promise<void> {
    try {
      for (const message of messages) await sender?.send(message);
    } catch {
      try {
        onFailure?.();
      } catch {
        // Telemetry failure must not recreate a recipient-dependent public error.
      }
    }
  }

  return {
    baseURL: environment.BETTER_AUTH_URL,
    emailEnabled: Boolean(sender),
    oauthProviders: Object.keys(options.socialProviders) as AuthOAuthProvider[],
    async handle(request, onEmailDeliveryFailure) {
      const pending: AuthEmail[] = [];
      const response = await delivery.run(pending, () => handleRequest(request));
      // Dispatch only after commit. Neither SMTP outcomes nor SMTP delays may
      // reveal which unauthenticated requests resulted in an email attempt.
      if (response.ok && sender && pending.length) {
        const task = deliverEmails(pending, onEmailDeliveryFailure);
        pendingDeliveries.add(task);
        void task.then(() => pendingDeliveries.delete(task));
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
    async close() {
      await Promise.all(pendingDeliveries);
    },
  };
}

class AuthTransactionFailure extends Error {
  constructor(readonly response: Response) {
    super("Authentication transaction failed");
  }
}
