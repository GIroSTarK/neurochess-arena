import { z } from "zod";

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

const apiEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: postgresUrlSchema,
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
    if (environment.NODE_ENV === "production" && environment.SANDBOX_ENABLED) {
      context.addIssue({ code: "custom", path: ["SANDBOX_ENABLED"] });
    }
  });

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

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
