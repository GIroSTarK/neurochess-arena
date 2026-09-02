import { z } from "zod";

const webEnvironmentSchema = z.object({
  VITE_API_BASE_URL: z.string().url(),
});

export interface WebEnvironment {
  readonly VITE_API_BASE_URL: string;
}

export class WebEnvironmentValidationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid environment variables: ${variables.join(", ")}`);
    this.name = "WebEnvironmentValidationError";
    this.variables = variables;
  }
}

export function parseWebEnvironment(input: Record<string, unknown>): WebEnvironment {
  const result = webEnvironmentSchema.safeParse(input);

  if (!result.success) {
    const variables = [
      ...new Set(
        result.error.issues.map((issue) =>
          typeof issue.path[0] === "string" ? issue.path[0] : "environment",
        ),
      ),
    ].toSorted();
    throw new WebEnvironmentValidationError(variables);
  }

  return result.data;
}
