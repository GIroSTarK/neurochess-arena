import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export function aiParametersPredicate(column: AnyPgColumn) {
  return sql`jsonb_typeof(${column}) = 'object'
    and octet_length(${column}::text) <= 512
    and ${column} - array['temperature', 'reasoningEffort', 'maxOutputTokens'] = '{}'::jsonb
    and (not (${column} ? 'temperature') or case
      when jsonb_typeof(${column}->'temperature') = 'number'
      then (${column}->>'temperature')::numeric between 0 and 9007199254740991
      else false end)
    and (not (${column} ? 'reasoningEffort') or (
      jsonb_typeof(${column}->'reasoningEffort') = 'string'
      and length(${column}->>'reasoningEffort') between 1 and 64
      and ${column}->>'reasoningEffort' ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'))
    and (not (${column} ? 'maxOutputTokens') or case
      when jsonb_typeof(${column}->'maxOutputTokens') = 'number'
      then (${column}->>'maxOutputTokens')::numeric between 1 and 9007199254740991
        and mod((${column}->>'maxOutputTokens')::numeric, 1) = 0
      else false end)`;
}
