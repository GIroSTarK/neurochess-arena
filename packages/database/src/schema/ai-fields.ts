import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  doublePrecision,
  pgEnum,
  text,
} from "drizzle-orm/pg-core";

export const aiProvider = pgEnum("ai_provider", ["openai", "anthropic", "google", "openrouter"]);

export function aiConfigurationColumns() {
  return {
    provider: aiProvider("provider"),
    modelId: text("model_id"),
    temperature: doublePrecision("temperature"),
    reasoningEffort: text("reasoning_effort"),
    maxOutputTokens: bigint("max_output_tokens", { mode: "number" }),
  };
}

export function aiConfigurationChecks(
  name: string,
  columns: { [Key in keyof ReturnType<typeof aiConfigurationColumns>]: AnyPgColumn },
) {
  return [
    check(
      `${name}_model_check`,
      sql`length(${columns.modelId}) between 1 and 200 and ${columns.modelId} !~ '[[:space:]]'`,
    ),
    check(
      `${name}_temperature_check`,
      sql`${columns.temperature} >= 0 and ${columns.temperature} < 'Infinity'::float8`,
    ),
    check(
      `${name}_reasoning_check`,
      sql`length(${columns.reasoningEffort}) between 1 and 64 and ${columns.reasoningEffort} !~ '[^a-z0-9_-]'`,
    ),
    check(
      `${name}_output_tokens_check`,
      sql`${columns.maxOutputTokens} between 1 and 9007199254740991`,
    ),
  ];
}
