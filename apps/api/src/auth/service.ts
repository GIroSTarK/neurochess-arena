import { AsyncLocalStorage } from "node:async_hooks";

import {
  authEmailRequestSchema,
  type AuthOAuthProvider,
  authResetPasswordRequestSchema,
  authSignInRequestSchema,
} from "@neurochess/contracts";
import {
  AccountDeletionSessionError,
  type AuthAccountActions,
  AuthAccountUnavailableError,
  cleanupSharedRooms,
  createAuthDatabaseAdapter,
  type DatabaseConnection,
  withAuthUserLock,
} from "@neurochess/database";
import { betterAuth } from "better-auth/minimal";
import { z } from "zod";

import { abortSharedGame } from "../games/account-deletion.js";
import { cleanupAfterCommit } from "../games/shared-room-cleanup.js";
import type { AccountPrincipal } from "../identity/principal.js";

import { accountDeletion } from "./account-deletion.js";
import type { AuthEmail, AuthEmailSender } from "./email.js";
import { AUTH_BASE_PATH, type AuthEnvironment, authOptions } from "./options.js";
import { verificationIdentity } from "./verification.js";

export interface AccountAuth {
  readonly baseURL: string;
  readonly emailEnabled?: boolean;
  readonly oauthProviders?: readonly AuthOAuthProvider[];
  handle(
    request: Request,
    onEmailDeliveryFailure?: () => void,
    onCleanupFailure?: () => void,
  ): Promise<Response>;
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
  const createAuth = (
    adapter: ReturnType<typeof createAuthDatabaseAdapter>,
    actions?: AuthAccountActions,
  ) =>
    betterAuth({
      ...options,
      session: { ...options.session, ...(actions ? { disableSessionRefresh: true } : {}) },
      plugins: [...options.plugins, accountDeletion(actions)],
      database: adapter,
    });
  const auth = createAuth(createAuthDatabaseAdapter(database));
  const getSession = (headers: Headers) =>
    auth.api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });

  async function handleRequest(request: Request, onCleanupFailure?: () => void): Promise<Response> {
    const path = new URL(request.url).pathname;
    const deleting = path === `${AUTH_BASE_PATH}/delete-account`;
    let userId: string | undefined;
    if (request.method === "GET" && path === `${AUTH_BASE_PATH}/verify-email`) {
      userId = (
        await verificationIdentity(
          new URL(request.url).searchParams.get("token") ?? "",
          environment.BETTER_AUTH_SECRET,
        )
      )?.accountId;
    }
    if (request.method === "POST" && (path === `${AUTH_BASE_PATH}/sign-out` || deleting)) {
      userId = (await getSession(request.headers))?.user.id;
    }
    if (
      sender &&
      request.method === "POST" &&
      (path === `${AUTH_BASE_PATH}/sign-in/email` ||
        path === `${AUTH_BASE_PATH}/reset-password` ||
        path === `${AUTH_BASE_PATH}/request-password-reset`)
    ) {
      const body: unknown = await request.clone().json();
      const context = await auth.$context;
      if (
        path === `${AUTH_BASE_PATH}/sign-in/email` ||
        path === `${AUTH_BASE_PATH}/request-password-reset`
      ) {
        const parsed = (
          path.endsWith("/sign-in/email") ? authSignInRequestSchema : authEmailRequestSchema
        ).safeParse(body);
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
      const response = await withAuthUserLock(
        database,
        z.uuid().parse(userId),
        async (adapter, actions) => {
          const response = await createAuth(adapter, deleting ? actions : undefined).handler(
            request,
          );
          // The library converts adapter errors into responses. Roll back password,
          // token and session changes together when it reports a server failure.
          if (response.status >= 500) {
            throw new AuthTransactionFailure(response);
          }
          return response;
        },
        deleting ? { abortSharedGame } : undefined,
      );
      if (deleting && response.ok) {
        await cleanupAfterCommit(() => cleanupSharedRooms(database), onCleanupFailure);
      }
      return response;
    } catch (error) {
      if (error instanceof AuthTransactionFailure) return error.response;
      if (
        path === `${AUTH_BASE_PATH}/verify-email` &&
        error instanceof AuthAccountUnavailableError
      ) {
        return Response.json({ code: "INVALID_TOKEN" }, { status: 401 });
      }
      if (
        deleting &&
        (error instanceof AuthAccountUnavailableError ||
          error instanceof AccountDeletionSessionError)
      ) {
        const code =
          error instanceof AccountDeletionSessionError ? error.code : "AUTH_UNAUTHORIZED";
        return Response.json({ code }, { status: code === "AUTH_REAUTH_REQUIRED" ? 403 : 401 });
      }
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
    async handle(request, onEmailDeliveryFailure, onCleanupFailure) {
      const pending: AuthEmail[] = [];
      const response = await delivery.run(pending, () => handleRequest(request, onCleanupFailure));
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
      return value
        ? {
            kind: "account",
            userId: z.uuid().parse(value.user.id),
            sessionId: z.uuid().parse(value.session.id),
          }
        : null;
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
