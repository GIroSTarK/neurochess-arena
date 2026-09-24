import { authEmailSchema, type AuthOAuthProvider } from "@neurochess/contracts";
import { getOAuthState } from "better-auth/api";
import { authorizationCodeRequest, type OAuthProvider } from "better-auth/oauth2";
import { z } from "zod";

const tokenSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});
const googleProfileSchema = z.object({
  sub: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/),
  email: authEmailSchema,
  email_verified: z.literal(true),
  picture: z.unknown().optional(),
});
const githubProfileSchema = z.object({
  id: z.int().positive(),
  avatar_url: z.unknown().optional(),
});
const githubEmailsSchema = z
  .array(
    z.object({
      email: authEmailSchema,
      primary: z.boolean(),
      verified: z.boolean(),
    }),
  )
  .max(100);

export function safeOAuthAvatar(provider: AuthOAuthProvider, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const approvedHost =
      provider === "google"
        ? /^lh[3-6]\.googleusercontent\.com$/.test(url.hostname)
        : url.hostname === "avatars.githubusercontent.com";
    if (
      url.protocol === "https:" &&
      approvedHost &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash
    ) {
      return url.href;
    }
  } catch {
    /* Invalid avatars use initials during profile onboarding. */
  }
  return undefined;
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) throw new Error("OAUTH_TRANSPORT_FAILED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error("OAUTH_INVALID_RESPONSE");
      size += value.byteLength;
      if (size > 131_072) throw new Error("OAUTH_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function protectOAuthTransport(
  provider: OAuthProvider,
  id: AuthOAuthProvider,
  fetcher: typeof fetch,
): OAuthProvider {
  return {
    ...provider,
    ...(id === "google" ? { issuer: "https://accounts.google.com" } : {}),
    async validateAuthorizationCode(input) {
      // Bind the library-verified state to its initiating provider before sending any code.
      const state = await getOAuthState();
      if (state?.serverContext?.provider !== id) return null;
      try {
        const request = await authorizationCodeRequest({
          ...input,
          options: provider.options ?? {},
        });
        const result = tokenSchema.parse(
          await requestJson(
            fetcher,
            id === "google"
              ? "https://oauth2.googleapis.com/token"
              : "https://github.com/login/oauth/access_token",
            { method: "POST", body: request.body, headers: request.headers },
          ),
        );
        // Login needs only a transient access token; ID/refresh tokens and raw responses are discarded.
        return { accessToken: result.access_token };
      } catch {
        // The built-in GitHub transport uses a global logger that can print upstream error bodies.
        return null;
      }
    },
    async getUserInfo(tokens) {
      try {
        if (!tokens.accessToken) return null;
        const headers = {
          authorization: `Bearer ${tokens.accessToken}`,
          accept: "application/json",
          "user-agent": "Neurochess-Arena",
        };
        if (id === "google") {
          const profile = googleProfileSchema.parse(
            await requestJson(fetcher, "https://openidconnect.googleapis.com/v1/userinfo", {
              headers,
            }),
          );
          return {
            user: {
              name: "",
              email: profile.email,
              emailVerified: true,
              image: safeOAuthAvatar(id, profile.picture),
            },
            data: { sub: profile.sub },
          };
        }
        const profile = githubProfileSchema.parse(
          await requestJson(fetcher, "https://api.github.com/user", { headers }),
        );
        const emails = githubEmailsSchema.parse(
          await requestJson(fetcher, "https://api.github.com/user/emails", { headers }),
        );
        const primary = emails.filter((email) => email.primary);
        if (primary.length !== 1 || !primary[0]?.verified) return null;
        return {
          user: {
            name: "",
            email: primary[0].email,
            emailVerified: true,
            image: safeOAuthAvatar(id, profile.avatar_url),
          },
          data: { id: profile.id },
        };
      } catch {
        return null;
      }
    },
  };
}
