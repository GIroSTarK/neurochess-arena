import { z } from "zod";

const databaseUrlSchema = z
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

export function parseDatabaseUrl(value: unknown, production = false): string {
  const result = databaseUrlSchema.safeParse(value);

  if (!result.success) {
    throw new Error("Invalid environment variables: DATABASE_URL");
  }

  if (production) {
    const url = new URL(result.data);
    if (
      url.searchParams.getAll("sslmode").length !== 1 ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      url.searchParams.has("ssl") ||
      url.searchParams.has("uselibpqcompat")
    ) {
      throw new Error("Invalid environment variables: DATABASE_URL");
    }
  }

  return result.data;
}
