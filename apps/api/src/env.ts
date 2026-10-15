import { parseDatabaseUrl } from "@neurochess/database";
import { getDomain } from "tldts";
import { z } from "zod";

import {
  credentialEncryptionKeySchema,
  credentialKeyIdSchema,
} from "./credentials/configuration.js";

const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      value === url.origin &&
      !url.hostname.includes("*") &&
      (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"))
    );
  } catch {
    return false;
  }
});

const postgresUrlSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "postgres:" || url.protocol === "postgresql:";
    } catch {
      return false;
    }
  });

const oauthCredentialSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/)
  .optional();

const apiEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    TRUSTED_PROXY_IP: z.union([z.ipv4(), z.ipv6()]).optional(),
    WEB_ORIGIN: originSchema.default("http://localhost:5173"),
    BETTER_AUTH_URL: originSchema,
    BETTER_AUTH_SECRET: z
      .string()
      .min(32)
      .refine((value) => value.trim().length >= 32),
    GOOGLE_CLIENT_ID: oauthCredentialSchema,
    GOOGLE_CLIENT_SECRET: oauthCredentialSchema,
    GITHUB_CLIENT_ID: oauthCredentialSchema,
    GITHUB_CLIENT_SECRET: oauthCredentialSchema,
    AUTH_EMAIL_TRANSPORT: z.enum(["disabled", "smtp"]).default("disabled"),
    AUTH_EMAIL_FROM: z.email().max(254).optional(),
    SMTP_HOST: z.union([z.hostname(), z.ipv4(), z.ipv6()]).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURITY: z.enum(["tls", "starttls", "none"]).default("starttls"),
    SMTP_USER: z.string().min(1).max(1024).optional(),
    SMTP_PASSWORD: z.string().min(1).max(4096).optional(),
    DATABASE_URL: postgresUrlSchema,
    CREDENTIAL_ENCRYPTION_KEY_ID: credentialKeyIdSchema.optional(),
    CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKeySchema.optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    SANDBOX_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    GUEST_SESSION_TTL_SECONDS: z.coerce.number().int().min(1).max(31_536_000).default(86_400),
  })
  .superRefine((environment, context) => {
    if (
      Boolean(environment.CREDENTIAL_ENCRYPTION_KEY_ID) !==
      Boolean(environment.CREDENTIAL_ENCRYPTION_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: [
          environment.CREDENTIAL_ENCRYPTION_KEY_ID
            ? "CREDENTIAL_ENCRYPTION_KEY"
            : "CREDENTIAL_ENCRYPTION_KEY_ID",
        ],
      });
    }
    for (const provider of ["GOOGLE", "GITHUB"] as const) {
      const id = `${provider}_CLIENT_ID` as const;
      const secret = `${provider}_CLIENT_SECRET` as const;
      if (Boolean(environment[id]) !== Boolean(environment[secret])) {
        context.addIssue({ code: "custom", path: [environment[id] ? secret : id] });
      }
    }
    if (environment.NODE_ENV === "production" && environment.AUTH_EMAIL_TRANSPORT !== "smtp") {
      context.addIssue({ code: "custom", path: ["AUTH_EMAIL_TRANSPORT"] });
    }
    if (environment.AUTH_EMAIL_TRANSPORT === "smtp") {
      for (const key of ["AUTH_EMAIL_FROM", "SMTP_HOST"] as const) {
        if (!environment[key]) context.addIssue({ code: "custom", path: [key] });
      }
      if (Boolean(environment.SMTP_USER) !== Boolean(environment.SMTP_PASSWORD)) {
        context.addIssue({
          code: "custom",
          path: [environment.SMTP_USER ? "SMTP_PASSWORD" : "SMTP_USER"],
        });
      }
      if (
        environment.SMTP_SECURITY === "none" &&
        (environment.NODE_ENV === "production" ||
          !["localhost", "127.0.0.1", "::1"].includes(environment.SMTP_HOST ?? "") ||
          Boolean(environment.SMTP_USER))
      ) {
        context.addIssue({ code: "custom", path: ["SMTP_SECURITY"] });
      }
    }
    if (environment.NODE_ENV === "production" && environment.SANDBOX_ENABLED) {
      context.addIssue({ code: "custom", path: ["SANDBOX_ENABLED"] });
    }
    if (environment.NODE_ENV === "production") {
      if (!environment.TRUSTED_PROXY_IP) {
        context.addIssue({ code: "custom", path: ["TRUSTED_PROXY_IP"] });
      }
      if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
        context.addIssue({ code: "custom", path: ["NODE_TLS_REJECT_UNAUTHORIZED"] });
      }
      if (!sameSite(environment.WEB_ORIGIN, environment.BETTER_AUTH_URL)) {
        context.addIssue({ code: "custom", path: ["WEB_ORIGIN"] });
      }
      try {
        parseDatabaseUrl(environment.DATABASE_URL, true);
      } catch {
        context.addIssue({ code: "custom", path: ["DATABASE_URL"] });
      }
      for (const key of ["WEB_ORIGIN", "BETTER_AUTH_URL"] as const) {
        if (!environment[key].startsWith("https://")) {
          context.addIssue({ code: "custom", path: [key] });
        }
      }
    }
  });

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

function sameSite(webOrigin: string, apiOrigin: string): boolean {
  try {
    const web = new URL(webOrigin).hostname;
    const api = new URL(apiOrigin).hostname;
    const domain = getDomain(web, { allowPrivateDomains: true });
    return (
      web === api || (domain !== null && domain === getDomain(api, { allowPrivateDomains: true }))
    );
  } catch {
    return false;
  }
}

export class EnvironmentValidationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid environment variables: ${variables.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.variables = variables;
  }
}

export function parseApiEnvironment(input: Record<string, unknown>): ApiEnvironment {
  const result = apiEnvironmentSchema.safeParse(input);

  if (!result.success) {
    const variables = [
      ...new Set(
        result.error.issues.map((issue) =>
          typeof issue.path[0] === "string" ? issue.path[0] : "environment",
        ),
      ),
    ].toSorted();

    throw new EnvironmentValidationError(variables);
  }

  return result.data;
}
