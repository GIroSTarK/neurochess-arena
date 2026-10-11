CREATE TABLE "game_analysis_samples" (
	"user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"fen" text NOT NULL,
	"history_digest" text NOT NULL,
	"profile_id" text NOT NULL,
	"depth" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"centipawns" integer,
	"mate_winner" text,
	"mate_moves" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_analysis_samples_user_id_game_id_ply_pk" PRIMARY KEY("user_id","game_id","ply"),
	CONSTRAINT "game_analysis_samples_ply_check" CHECK ("game_analysis_samples"."ply" >= 0),
	CONSTRAINT "game_analysis_samples_identity_check" CHECK (length("game_analysis_samples"."fen") between 1 and 128
    and "game_analysis_samples"."history_digest" ~ '^[0-9a-f]{64}$'
    and "game_analysis_samples"."profile_id" ~ '^[a-zA-Z0-9-]{1,64}$'),
	CONSTRAINT "game_analysis_samples_limits_check" CHECK ("game_analysis_samples"."depth" between 0 and 18 and "game_analysis_samples"."duration_ms" between 0 and 3000),
	CONSTRAINT "game_analysis_samples_score_check" CHECK (((
    "game_analysis_samples"."centipawns" is not null and "game_analysis_samples"."centipawns" between -100000 and 100000
    and "game_analysis_samples"."mate_winner" is null and "game_analysis_samples"."mate_moves" is null
  ) or (
    "game_analysis_samples"."centipawns" is null and "game_analysis_samples"."mate_winner" in ('white', 'black')
    and "game_analysis_samples"."mate_moves" between 0 and 128
  )) is true)
);
--> statement-breakpoint
ALTER TABLE "game_analysis_samples" ADD CONSTRAINT "game_analysis_samples_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_analysis_samples" ADD CONSTRAINT "game_analysis_samples_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_analysis_samples_game_idx" ON "game_analysis_samples" USING btree ("game_id");