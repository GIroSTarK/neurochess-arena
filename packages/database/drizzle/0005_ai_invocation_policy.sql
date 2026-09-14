ALTER TYPE "public"."game_command_kind" ADD VALUE 'technical_loss';--> statement-breakpoint
CREATE TABLE "ai_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"color" "chess_color" NOT NULL,
	"invalid_output_count" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"accepted_move_ply" integer,
	CONSTRAINT "ai_turns_ply_check" CHECK ("ai_turns"."ply" > 0 and ("ai_turns"."accepted_move_ply" is null or "ai_turns"."accepted_move_ply" = "ai_turns"."ply")),
	CONSTRAINT "ai_turns_budget_check" CHECK ("ai_turns"."invalid_output_count" between 0 and 3 and "ai_turns"."attempt_count" >= "ai_turns"."invalid_output_count"),
	CONSTRAINT "ai_turns_color_check" CHECK (("ai_turns"."ply" % 2 = 1 and "ai_turns"."color" = 'white') or ("ai_turns"."ply" % 2 = 0 and "ai_turns"."color" = 'black'))
);
--> statement-breakpoint
CREATE TABLE "model_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"reservation_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"expected_version" bigint NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"model_id" text NOT NULL,
	"effective_parameters" jsonb NOT NULL,
	"outcome" text DEFAULT 'in_flight' NOT NULL,
	"error_code" text,
	"error_reason" text,
	"duration_ms" bigint,
	"usage_reported" boolean DEFAULT false NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"total_tokens" bigint,
	"commentary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_invocations_sequence_check" CHECK ("model_invocations"."attempt_number" > 0 and "model_invocations"."expected_version" between 0 and 9007199254740991),
	CONSTRAINT "model_invocations_outcome_check" CHECK ("model_invocations"."outcome" in ('in_flight', 'accepted', 'model_invalid', 'provider_error', 'interrupted', 'discarded')),
	CONSTRAINT "model_invocations_error_check" CHECK (
      (("model_invocations"."error_code" is null and "model_invocations"."error_reason" is null)
      or ("model_invocations"."error_code" = 'model_invalid' and "model_invocations"."error_reason" is not null and "model_invocations"."error_reason" in ('malformed_output', 'illegal_move', 'refusal', 'truncated_output'))
      or ("model_invocations"."error_code" in ('provider_auth', 'provider_quota', 'provider_timeout') and "model_invocations"."error_reason" is null)
      or ("model_invocations"."error_code" = 'provider_unavailable' and "model_invocations"."error_reason" is not null and "model_invocations"."error_reason" in ('network', 'upstream', 'invalid_response', 'unsupported_model', 'cancelled'))) is true),
	CONSTRAINT "model_invocations_result_check" CHECK (
      ("model_invocations"."outcome" in ('in_flight', 'interrupted') and "model_invocations"."error_code" is null and "model_invocations"."duration_ms" is null and not "model_invocations"."usage_reported" and "model_invocations"."commentary" is null)
      or ("model_invocations"."duration_ms" is not null and (
        ("model_invocations"."outcome" = 'accepted' and "model_invocations"."error_code" is null)
        or ("model_invocations"."commentary" is null and (
          ("model_invocations"."outcome" = 'model_invalid' and "model_invocations"."error_code" is not null and "model_invocations"."error_code" = 'model_invalid')
          or ("model_invocations"."outcome" = 'provider_error' and "model_invocations"."error_code" is not null and "model_invocations"."error_code" <> 'model_invalid')
          or "model_invocations"."outcome" = 'discarded'))))),
	CONSTRAINT "model_invocations_usage_check" CHECK (("model_invocations"."usage_reported" or ("model_invocations"."input_tokens" is null and "model_invocations"."output_tokens" is null and "model_invocations"."total_tokens" is null))
      and ("model_invocations"."duration_ms" is null or "model_invocations"."duration_ms" between 0 and 9007199254740991)
      and ("model_invocations"."input_tokens" is null or "model_invocations"."input_tokens" between 0 and 9007199254740991)
      and ("model_invocations"."output_tokens" is null or "model_invocations"."output_tokens" between 0 and 9007199254740991)
      and ("model_invocations"."total_tokens" is null or "model_invocations"."total_tokens" between 0 and 9007199254740991)),
	CONSTRAINT "model_invocations_commentary_check" CHECK ("model_invocations"."commentary" is null or length("model_invocations"."commentary") <= 2000),
	CONSTRAINT "model_invocations_model_id_check" CHECK (length("model_invocations"."model_id") between 1 and 256 and "model_invocations"."model_id" ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$'),
	CONSTRAINT "model_invocations_parameters_check" CHECK (jsonb_typeof("model_invocations"."effective_parameters") = 'object'
      and octet_length("model_invocations"."effective_parameters"::text) <= 512
      and "model_invocations"."effective_parameters" - array['temperature', 'reasoningEffort', 'maxOutputTokens'] = '{}'::jsonb
      and (not ("model_invocations"."effective_parameters" ? 'temperature') or case
        when jsonb_typeof("model_invocations"."effective_parameters"->'temperature') = 'number'
        then ("model_invocations"."effective_parameters"->>'temperature')::numeric between 0 and 9007199254740991 else false end)
      and (not ("model_invocations"."effective_parameters" ? 'reasoningEffort') or (
        jsonb_typeof("model_invocations"."effective_parameters"->'reasoningEffort') = 'string'
        and length("model_invocations"."effective_parameters"->>'reasoningEffort') between 1 and 64
        and "model_invocations"."effective_parameters"->>'reasoningEffort' ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'))
      and (not ("model_invocations"."effective_parameters" ? 'maxOutputTokens') or case
        when jsonb_typeof("model_invocations"."effective_parameters"->'maxOutputTokens') = 'number'
        then ("model_invocations"."effective_parameters"->>'maxOutputTokens')::numeric between 1 and 9007199254740991
          and mod(("model_invocations"."effective_parameters"->>'maxOutputTokens')::numeric, 1) = 0 else false end))
);
--> statement-breakpoint
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_game_id_accepted_move_ply_moves_game_id_ply_fk" FOREIGN KEY ("game_id","accepted_move_ply") REFERENCES "public"."moves"("game_id","ply") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_turn_id_ai_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."ai_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turns_ply_unique" ON "ai_turns" USING btree ("game_id","ply");--> statement-breakpoint
CREATE UNIQUE INDEX "model_invocations_attempt_unique" ON "model_invocations" USING btree ("turn_id","attempt_number");--> statement-breakpoint
CREATE INDEX "model_invocations_reservation_idx" ON "model_invocations" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_invocations_pending_unique" ON "model_invocations" USING btree ("reservation_id") WHERE "model_invocations"."outcome" = 'in_flight';--> statement-breakpoint
CREATE UNIQUE INDEX "model_invocations_accepted_unique" ON "model_invocations" USING btree ("turn_id") WHERE "model_invocations"."outcome" = 'accepted';