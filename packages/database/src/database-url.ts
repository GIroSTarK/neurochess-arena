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

export function parseDatabaseUrl(value: unknown): string {
  const result = databaseUrlSchema.safeParse(value);

  if (!result.success) {
    throw new Error("Invalid environment variables: DATABASE_URL");
  }

  return result.data;
}
