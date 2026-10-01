import { createHash } from "node:crypto";

import { expect, vi } from "vitest";

export type OAuthProvider = "google" | "github";

export function createOAuthTransport() {
  const profiles = {
    google: {
      sub: "google-fixture-subject",
      email: "fixture@example.com",
      email_verified: true,
      name: "untrusted-name-canary",
      picture: "https://lh3.googleusercontent.com/fixture-avatar",
    } as Record<string, unknown>,
    github: {
      id: 12345678,
      email: null,
      login: "untrusted-login-canary",
      name: "untrusted-name-canary",
      avatar_url: "https://avatars.githubusercontent.com/u/12345678",
    } as Record<string, unknown>,
  };
  let emails: unknown = [{ email: "fixture@example.com", primary: true, verified: true }];
  const grants = new Map<string, { provider: OAuthProvider; url: URL }>();
  const failures = new Map<string, Response | Error>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const failure = failures.get(request.url);
    if (failure instanceof Error) throw failure;
    if (failure) return failure.clone();
    if (
      [
        "https://oauth2.googleapis.com/token",
        "https://github.com/login/oauth/access_token",
      ].includes(request.url)
    ) {
      const body = new URLSearchParams(await request.text());
      const grant = grants.get(body.get("code") ?? "");
      if (!grant) {
        return Response.json(
          { error: "invalid_grant", error_description: "provider-secret-canary" },
          { status: 400 },
        );
      }
      grants.delete(body.get("code")!);
      expect(request.url).toBe(
        grant.provider === "google"
          ? "https://oauth2.googleapis.com/token"
          : "https://github.com/login/oauth/access_token",
      );
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("redirect_uri")).toBe(grant.url.searchParams.get("redirect_uri"));
      expect(body.get("client_id")).toBe(`${grant.provider}-fixture-client`);
      expect(body.get("client_secret")).toBe(`${grant.provider}-secret-canary`);
      expect(
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(grant.url.searchParams.get("code_challenge"));
      const claims = {
        ...profiles.google,
        iss: "https://accounts.google.com",
        aud: "google-fixture-client",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const idToken = [
        Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
        Buffer.from(JSON.stringify(claims)).toString("base64url"),
        "fixture-signature",
      ].join(".");
      return Response.json({
        access_token: `${grant.provider}-access-token-canary`,
        refresh_token: `${grant.provider}-refresh-token-canary`,
        id_token: grant.provider === "google" ? idToken : undefined,
        token_type: "Bearer",
        expires_in: 3600,
        scope: grant.url.searchParams.get("scope"),
      });
    }
    if (
      request.url === "https://api.github.com/user" ||
      request.url === "https://api.github.com/user/emails"
    ) {
      expect(request.headers.get("authorization")).toBe("Bearer github-access-token-canary");
      return Response.json(request.url.endsWith("/emails") ? emails : profiles.github);
    }
    throw new Error("Unexpected OAuth transport destination");
  });
  return {
    fetch,
    profiles,
    failures,
    setEmails(value: unknown) {
      emails = value;
    },
    grant(provider: OAuthProvider, url: URL, code: string) {
      grants.set(code, { provider, url });
    },
  };
}
