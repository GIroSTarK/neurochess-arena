CREATE TYPE "public"."chess_color" AS ENUM('white', 'black');--> statement-breakpoint
CREATE TYPE "public"."game_result" AS ENUM('*', '1-0', '0-1', '1/2-1/2');--> statement-breakpoint
CREATE TYPE "public"."game_state" AS ENUM('configuring', 'active', 'paused', 'completed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."seat_type" AS ENUM('human', 'ai');--> statement-breakpoint
CREATE TYPE "public"."termination_reason" AS ENUM('checkmate', 'human_resignation', 'model_technical_loss', 'stalemate', 'insufficient_material', 'threefold_repetition', 'fifty_move_rule', 'aborted');--> statement-breakpoint
CREATE TABLE "game_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"color" "chess_color" NOT NULL,
	"seat_type" "seat_type" NOT NULL,
	"guest_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_participants_identity_check" CHECK ("game_participants"."seat_type" = 'human' or "game_participants"."guest_session_id" is null)
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_guest_session_id" uuid NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"state" "game_state" NOT NULL,
	"result" "game_result" NOT NULL,
	"termination_reason" "termination_reason",
	"fen" text NOT NULL,
	"pgn" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_version_check" CHECK ("games"."version" between 0 and 9007199254740991),
	CONSTRAINT "games_position_check" CHECK (length("games"."fen") > 0 and length("games"."pgn") > 0),
	CONSTRAINT "games_lifecycle_check" CHECK (
    ("games"."state" in ('configuring', 'active', 'paused') and "games"."result" = '*' and "games"."termination_reason" is null)
    or ("games"."state" = 'completed' and "games"."result" in ('1-0', '0-1') and "games"."termination_reason" is not null
      and "games"."termination_reason" in ('checkmate', 'human_resignation', 'model_technical_loss'))
    or ("games"."state" = 'completed' and "games"."result" = '1/2-1/2' and "games"."termination_reason" is not null
      and "games"."termination_reason" in ('stalemate', 'insufficient_material', 'threefold_repetition', 'fifty_move_rule'))
    or ("games"."state" = 'aborted' and "games"."result" = '*' and "games"."termination_reason" is not null
      and "games"."termination_reason" = 'aborted')
  )
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guest_sessions_token_hash_check" CHECK ("guest_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "guest_sessions_expiry_check" CHECK ("guest_sessions"."expires_at" > "guest_sessions"."last_seen_at")
);
--> statement-breakpoint
CREATE TABLE "moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"uci" text NOT NULL,
	"san" text NOT NULL,
	"fen" text NOT NULL,
	"command_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moves_ply_check" CHECK ("moves"."ply" > 0),
	CONSTRAINT "moves_version_check" CHECK ("moves"."version" between 1 and 9007199254740991),
	CONSTRAINT "moves_uci_check" CHECK ("moves"."uci" ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'
    and length("moves"."uci") in (4, 5) and left("moves"."uci", 2) <> substring("moves"."uci" from 3 for 2)),
	CONSTRAINT "moves_position_check" CHECK (length("moves"."san") > 0 and length("moves"."fen") > 0)
);
--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_owner_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("owner_guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_participants_color_unique" ON "game_participants" USING btree ("game_id","color");--> statement-breakpoint
CREATE UNIQUE INDEX "game_participants_guest_unique" ON "game_participants" USING btree ("game_id","guest_session_id");--> statement-breakpoint
CREATE INDEX "game_participants_guest_idx" ON "game_participants" USING btree ("guest_session_id");--> statement-breakpoint
CREATE INDEX "games_owner_idx" ON "games" USING btree ("owner_guest_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "games_one_unfinished_per_guest" ON "games" USING btree ("owner_guest_session_id") WHERE "games"."state" in ('active', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "guest_sessions_token_hash_unique" ON "guest_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_sessions_expiry_idx" ON "guest_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "moves_ply_unique" ON "moves" USING btree ("game_id","ply");--> statement-breakpoint
CREATE UNIQUE INDEX "moves_command_unique" ON "moves" USING btree ("game_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moves_version_unique" ON "moves" USING btree ("game_id","version");