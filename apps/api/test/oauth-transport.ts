import { createHash, randomUUID } from "node:crypto";

import type { AuthOAuthProvider } from "@neurochess/contracts";

export const OAUTH_ENVIRONMENT = {
  GOOGLE_CLIENT_ID: "test-google.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-client-secret-canary",
  GITHUB_CLIENT_ID: "test-github",
  GITHUB_CLIENT_SECRET: "github-client-secret-canary",
};

export interface OAuthGrant {
  provider: AuthOAuthProvider;
  authorization: URL;
  email: string;
  subject: number;
  profile?: unknown;
  emails?: unknown;
  tokenResponse?: unknown;
  failure?: "token" | "profile" | "redirect" | "network" | "oversized";
}

export class TestOAuthTransport {
  readonly grants = new Map<string, OAuthGrant>();
  readonly accesses = new Map<string, OAuthGrant>();
  exchanges = 0;
  profiles = 0;
  pkceVerified = 0;

  grant(input: OAuthGrant): string {
    const code = `code-canary-${randomUUID()}`;
    this.grants.set(code, input);
    return code;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (
      url === "https://oauth2.googleapis.com/token" ||
      url === "https://github.com/login/oauth/access_token"
    ) {
      this.exchanges++;
      if (!(init?.body instanceof URLSearchParams)) {
        throw new Error("Unexpected OAuth request body");
      }
      const body = init.body;
      const code = body.get("code") ?? "";
      const grant = this.grants.get(code);
      this.grants.delete(code);
      if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (grant.failure === "network") throw new Error("network-secret-canary");
      if (grant.failure === "token") {
        return Response.json({ error: "token-secret-canary" }, { status: 400 });
      }
      if (grant.failure === "redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/token-secret-canary" },
        });
      }
      if (grant.failure === "oversized") return new Response("x".repeat(131_073));
      const verifier = body.get("code_verifier");
      if (
        !verifier ||
        createHash("sha256").update(verifier).digest("base64url") !==
          grant.authorization.searchParams.get("code_challenge") ||
        body.get("redirect_uri") !== grant.authorization.searchParams.get("redirect_uri") ||
        body.get("client_id") !== grant.authorization.searchParams.get("client_id") ||
        init.redirect !== "error"
      ) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      this.pkceVerified++;
      const token = `access-token-canary-${randomUUID()}`;
      this.accesses.set(token, grant);
      return Response.json(
        grant.tokenResponse ?? {
          access_token: token,
          token_type: "Bearer",
          refresh_token: "refresh-token-canary",
          id_token: "id-token-canary",
          scope: "unneeded-provider-scope",
        },
      );
    }
    this.profiles++;
    const token = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length) ?? "";
    const grant = this.accesses.get(token);
    if (!grant || grant.failure === "profile") {
      return Response.json({ error: "profile-secret-canary" }, { status: 503 });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json(
        grant.profile ?? {
          sub: String(grant.subject),
          email: grant.email,
          email_verified: true,
          name: "private-provider-name-canary",
          picture: "https://lh3.googleusercontent.com/a/test-avatar",
        },
      );
    }
    if (url === "https://api.github.com/user") {
      return Response.json(
        grant.profile ?? {
          id: grant.subject,
          email: null,
          name: "private-provider-name-canary",
          login: "private-login-canary",
          avatar_url: "https://avatars.githubusercontent.com/u/123",
        },
      );
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json(
        grant.emails ?? [
          { email: grant.email, primary: true, verified: true },
          { email: "private-secondary@example.test", primary: false, verified: true },
        ],
      );
    }
    throw new Error("Unexpected OAuth transport destination");
  };
}
