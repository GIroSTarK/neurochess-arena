CREATE TYPE "public"."ai_game_mode" AS ENUM('ai_vs_ai', 'ai_vs_human');--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('openai', 'anthropic', 'google', 'openrouter');--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "provider" "ai_provider";--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "parameters" jsonb;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "mode" "ai_game_mode";--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_configuration_check" CHECK (("game_participants"."seat_type" = 'human' and "game_participants"."provider" is null
        and "game_participants"."model_id" is null and "game_participants"."parameters" is null)
      or ("game_participants"."seat_type" = 'ai' and "game_participants"."provider" is not null
        and "game_participants"."model_id" is not null and "game_participants"."parameters" is not null));--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_model_id_check" CHECK ("game_participants"."model_id" is null or (length("game_participants"."model_id") between 1 and 256
        and "game_participants"."model_id" ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$'));--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_parameters_check" CHECK ("game_participants"."parameters" is null or (
        jsonb_typeof("game_participants"."parameters") = 'object'
        and octet_length("game_participants"."parameters"::text) <= 512
        and "game_participants"."parameters" - array['temperature', 'reasoningEffort', 'maxOutputTokens'] = '{}'::jsonb
        and (not ("game_participants"."parameters" ? 'temperature') or case
          when jsonb_typeof("game_participants"."parameters"->'temperature') = 'number'
          then ("game_participants"."parameters"->>'temperature')::numeric between 0 and 9007199254740991
          else false end)
        and (not ("game_participants"."parameters" ? 'reasoningEffort') or (
          jsonb_typeof("game_participants"."parameters"->'reasoningEffort') = 'string'
          and length("game_participants"."parameters"->>'reasoningEffort') between 1 and 64
          and "game_participants"."parameters"->>'reasoningEffort' ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'))
        and (not ("game_participants"."parameters" ? 'maxOutputTokens') or case
          when jsonb_typeof("game_participants"."parameters"->'maxOutputTokens') = 'number'
          then ("game_participants"."parameters"->>'maxOutputTokens')::numeric between 1 and 9007199254740991
            and mod(("game_participants"."parameters"->>'maxOutputTokens')::numeric, 1) = 0
          else false end)
      ));--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_sandbox_mode_check" CHECK (not "games"."is_sandbox" or "games"."mode" is null);