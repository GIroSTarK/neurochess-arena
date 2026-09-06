CREATE TYPE "public"."ai_provider" AS ENUM('openai', 'anthropic', 'google', 'openrouter');--> statement-breakpoint
CREATE TYPE "public"."game_mode" AS ENUM('human_vs_human', 'ai_vs_ai', 'ai_vs_human');--> statement-breakpoint
CREATE TYPE "public"."invocation_error_kind" AS ENUM('model_invalid', 'provider_auth', 'provider_quota', 'provider_timeout', 'provider_unavailable');--> statement-breakpoint
CREATE TYPE "public"."invocation_status" AS ENUM('pending', 'succeeded', 'model_invalid', 'provider_error', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."model_invalid_reason" AS ENUM('malformed_output', 'illegal_move');--> statement-breakpoint
CREATE TYPE "public"."turn_reservation_status" AS ENUM('reserved', 'committed', 'cancelled', 'abandoned');--> statement-breakpoint
ALTER TYPE "public"."game_command_kind" ADD VALUE 'technical_loss';--> statement-breakpoint
CREATE TABLE "model_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider" "ai_provider",
	"model_id" text,
	"temperature" double precision,
	"reasoning_effort" text,
	"max_output_tokens" bigint,
	"status" "invocation_status" DEFAULT 'pending' NOT NULL,
	"move" text,
	"commentary" text,
	"error_kind" "invocation_error_kind",
	"invalid_reason" "model_invalid_reason",
	"latency_ms" double precision,
	"usage_reported" boolean DEFAULT false NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"total_tokens" bigint,
	"provider_request_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "model_invocations_attempt_check" CHECK ("model_invocations"."attempt" between 1 and 3),
	CONSTRAINT "model_invocations_configuration_check" CHECK ("model_invocations"."provider" is not null and "model_invocations"."model_id" is not null),
	CONSTRAINT "model_invocations_model_check" CHECK (length("model_invocations"."model_id") between 1 and 200 and "model_invocations"."model_id" !~ '[[:space:]]'),
	CONSTRAINT "model_invocations_temperature_check" CHECK ("model_invocations"."temperature" >= 0 and "model_invocations"."temperature" < 'Infinity'::float8),
	CONSTRAINT "model_invocations_reasoning_check" CHECK (length("model_invocations"."reasoning_effort") between 1 and 64 and "model_invocations"."reasoning_effort" !~ '[^a-z0-9_-]'),
	CONSTRAINT "model_invocations_output_tokens_check" CHECK ("model_invocations"."max_output_tokens" between 1 and 9007199254740991),
	CONSTRAINT "model_invocations_result_check" CHECK (("model_invocations"."status" = 'succeeded' and "model_invocations"."move" is not null and "model_invocations"."error_kind" is null and "model_invocations"."invalid_reason" is null)
        or ("model_invocations"."status" = 'model_invalid' and "model_invocations"."move" is null and "model_invocations"."commentary" is null
          and "model_invocations"."error_kind" is not null and "model_invocations"."error_kind" = 'model_invalid' and "model_invocations"."invalid_reason" is not null)
        or ("model_invocations"."status" = 'provider_error' and "model_invocations"."move" is null and "model_invocations"."commentary" is null
          and "model_invocations"."error_kind" is not null and "model_invocations"."error_kind" <> 'model_invalid' and "model_invocations"."invalid_reason" is null)
        or ("model_invocations"."status" in ('pending', 'abandoned') and "model_invocations"."move" is null and "model_invocations"."commentary" is null
          and "model_invocations"."error_kind" is null and "model_invocations"."invalid_reason" is null)),
	CONSTRAINT "model_invocations_move_check" CHECK ("model_invocations"."move" ~ '^[a-h][1-8][a-h][1-8][qrbn]?$' and length("model_invocations"."move") in (4, 5)
        and left("model_invocations"."move", 2) <> substring("model_invocations"."move" from 3 for 2)),
	CONSTRAINT "model_invocations_commentary_check" CHECK (length("model_invocations"."commentary") <= 2000),
	CONSTRAINT "model_invocations_timing_check" CHECK (("model_invocations"."status" = 'pending' and "model_invocations"."finished_at" is null)
        or ("model_invocations"."status" <> 'pending' and "model_invocations"."finished_at" is not null and "model_invocations"."finished_at" >= "model_invocations"."started_at")),
	CONSTRAINT "model_invocations_telemetry_check" CHECK (("model_invocations"."status" in ('pending', 'abandoned') and "model_invocations"."latency_ms" is null and not "model_invocations"."usage_reported" and "model_invocations"."provider_request_id" is null)
        or ("model_invocations"."status" in ('succeeded', 'model_invalid', 'provider_error') and "model_invocations"."latency_ms" is not null
          and "model_invocations"."latency_ms" >= 0 and "model_invocations"."latency_ms" < 'Infinity'::float8)),
	CONSTRAINT "model_invocations_usage_check" CHECK ("model_invocations"."usage_reported" or ("model_invocations"."input_tokens" is null and "model_invocations"."output_tokens" is null and "model_invocations"."total_tokens" is null)),
	CONSTRAINT "model_invocations_inputTokens_check" CHECK ("model_invocations"."input_tokens" between 0 and 9007199254740991),
	CONSTRAINT "model_invocations_outputTokens_check" CHECK ("model_invocations"."output_tokens" between 0 and 9007199254740991),
	CONSTRAINT "model_invocations_totalTokens_check" CHECK ("model_invocations"."total_tokens" between 0 and 9007199254740991),
	CONSTRAINT "model_invocations_request_id_check" CHECK (length("model_invocations"."provider_request_id") between 1 and 200 and "model_invocations"."provider_request_id" !~ '[^a-zA-Z0-9_.:-]')
);
--> statement-breakpoint
CREATE TABLE "turn_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"owner_guest_session_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"expected_version" bigint NOT NULL,
	"color" "chess_color" NOT NULL,
	"seat_type" "seat_type" DEFAULT 'ai' NOT NULL,
	"executor_id" uuid NOT NULL,
	"status" "turn_reservation_status" DEFAULT 'reserved' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "turn_reservations_ai_check" CHECK ("turn_reservations"."seat_type" = 'ai'),
	CONSTRAINT "turn_reservations_version_check" CHECK ("turn_reservations"."expected_version" between 0 and 9007199254740990),
	CONSTRAINT "turn_reservations_lease_check" CHECK ("turn_reservations"."lease_expires_at" > "turn_reservations"."created_at"),
	CONSTRAINT "turn_reservations_status_check" CHECK (("turn_reservations"."status" = 'reserved' and "turn_reservations"."ended_at" is null)
        or ("turn_reservations"."status" <> 'reserved' and "turn_reservations"."ended_at" is not null and "turn_reservations"."ended_at" >= "turn_reservations"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "provider" "ai_provider";--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "temperature" double precision;--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "max_output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "mode" "game_mode" DEFAULT 'human_vs_human' NOT NULL;--> statement-breakpoint
CREATE INDEX "model_invocations_game_idx" ON "model_invocations" USING btree ("game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_invocations_attempt_unique" ON "model_invocations" USING btree ("reservation_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "model_invocations_one_pending" ON "model_invocations" USING btree ("reservation_id") WHERE "model_invocations"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "turn_reservations_id_game_unique" ON "turn_reservations" USING btree ("id","game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "turn_reservations_command_unique" ON "turn_reservations" USING btree ("game_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "turn_reservations_version_unique" ON "turn_reservations" USING btree ("game_id","expected_version");--> statement-breakpoint
CREATE UNIQUE INDEX "turn_reservations_one_pending_per_game" ON "turn_reservations" USING btree ("game_id") WHERE "turn_reservations"."status" = 'reserved';--> statement-breakpoint
CREATE UNIQUE INDEX "game_participants_color_type_unique" ON "game_participants" USING btree ("game_id","color","seat_type");--> statement-breakpoint
CREATE UNIQUE INDEX "games_id_owner_unique" ON "games" USING btree ("id","owner_guest_session_id");--> statement-breakpoint
-- Referenced composite unique indexes must exist before these foreign keys.
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_reservation_id_game_id_turn_reservations_id_game_id_fk" FOREIGN KEY ("reservation_id","game_id") REFERENCES "public"."turn_reservations"("id","game_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_reservations" ADD CONSTRAINT "turn_reservations_game_id_owner_guest_session_id_games_id_owner_guest_session_id_fk" FOREIGN KEY ("game_id","owner_guest_session_id") REFERENCES "public"."games"("id","owner_guest_session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_reservations" ADD CONSTRAINT "turn_reservations_game_id_color_seat_type_game_participants_game_id_color_seat_type_fk" FOREIGN KEY ("game_id","color","seat_type") REFERENCES "public"."game_participants"("game_id","color","seat_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_configuration_check" CHECK (("game_participants"."seat_type" = 'ai' and "game_participants"."provider" is not null and "game_participants"."model_id" is not null)
        or ("game_participants"."seat_type" = 'human' and "game_participants"."provider" is null and "game_participants"."model_id" is null
          and "game_participants"."temperature" is null and "game_participants"."reasoning_effort" is null and "game_participants"."max_output_tokens" is null));--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_model_check" CHECK (length("game_participants"."model_id") between 1 and 200 and "game_participants"."model_id" !~ '[[:space:]]');--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_temperature_check" CHECK ("game_participants"."temperature" >= 0 and "game_participants"."temperature" < 'Infinity'::float8);--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_reasoning_check" CHECK (length("game_participants"."reasoning_effort") between 1 and 64 and "game_participants"."reasoning_effort" !~ '[^a-z0-9_-]');--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_output_tokens_check" CHECK ("game_participants"."max_output_tokens" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_sandbox_mode_check" CHECK (not "games"."is_sandbox" or "games"."mode" = 'human_vs_human');