import { z } from "zod";

const webEnvironmentSchema = z.object({
  VITE_API_BASE_URL: z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/"
    );
  }),
});

export interface WebEnvironment {
  readonly VITE_API_BASE_URL: string;
}

export class WebEnvironmentValidationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super("INVALID_WEB_ENVIRONMENT");
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
