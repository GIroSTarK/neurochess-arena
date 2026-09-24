import { randomUUID } from "node:crypto";

import type { DatabaseConnection } from "@neurochess/database";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";

import type { AuthEmail, AuthEmailSender } from "../src/auth/email.js";
import { AUTH_COOKIE_NAME, type AuthService, createAuth } from "../src/auth/service.js";

export class TestMailbox implements AuthEmailSender {
  readonly messages: AuthEmail[] = [];
  failure = false;

  async send(message: AuthEmail): Promise<void> {
    if (this.failure) throw new Error("smtp-password-and-token-secret-canary");
    this.messages.push(message);
  }

  link(email: string, kind: "verification" | "reset"): URL {
    const message = this.messages.findLast(
      (item) =>
        item.to === email.toLowerCase() &&
        item.subject.includes(kind === "verification" ? "Verify" : "Reset"),
    );
    const link = message?.text.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw new Error("Test mailbox link missing");
    return new URL(link);
  }

  token(email: string, kind: "verification" | "reset"): string {
    const token = new URLSearchParams(this.link(email, kind).hash.slice(1)).get("token");
    if (!token) throw new Error("Test mailbox token missing");
    return token;
  }
}

export const AUTH_ENVIRONMENT = {
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "test-only-foundation-auth-9274b1b8c2dc4e1482860c564d23c784",
};

export function fixtureAuth(
  database: DatabaseConnection,
  environment = AUTH_ENVIRONMENT,
): AuthService {
  const foundation = createAuth(database, environment);
  // Session/guest fixtures bypass email only in tests; lifecycle tests use the real verified flow.
  return betterAuth<BetterAuthOptions>({
    ...foundation.options,
    emailAndPassword: { enabled: true, disableSignUp: false, minPasswordLength: 12 },
  });
}

export async function registerFixture(auth: AuthService) {
  const email = `${randomUUID()}@example.test`;
  const password = "test-only-password-329e9a1f";
  const response = await auth.api.signUpEmail({
    body: { email, password, name: "Private fixture name" },
    asResponse: true,
  });
  if (response.status !== 200) throw new Error("Account fixture creation failed");
  const body = (await response.json()) as { user: { id: string }; token: string };
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find((value) => value.startsWith(`${AUTH_COOKIE_NAME}=`))?.split(";")[0];
  if (!cookie) throw new Error("Account fixture cookie missing");
  return { userId: body.user.id, email, password, token: body.token, cookie, cookies };
}
