CREATE TABLE "ai_turn_reservations" (
	"game_id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"expected_version" bigint NOT NULL,
	"state" text DEFAULT 'in_flight' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_turn_reservations_version_check" CHECK ("ai_turn_reservations"."expected_version" between 0 and 9007199254740991),
	CONSTRAINT "ai_turn_reservations_state_check" CHECK ("ai_turn_reservations"."state" in ('in_flight', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "ai_turn_reservations" ADD CONSTRAINT "ai_turn_reservations_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;