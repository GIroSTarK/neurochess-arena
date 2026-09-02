CREATE TYPE "public"."game_command_kind" AS ENUM('move', 'pause', 'resume', 'abort', 'resign');--> statement-breakpoint
CREATE TABLE "game_commands" (
	"game_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"kind" "game_command_kind" NOT NULL,
	"version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_commands_game_id_command_id_pk" PRIMARY KEY("game_id","command_id"),
	CONSTRAINT "game_commands_version_check" CHECK ("game_commands"."version" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "game_commands" ADD CONSTRAINT "game_commands_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_commands_version_unique" ON "game_commands" USING btree ("game_id","version");
--> statement-breakpoint
-- Preserve accepted command identities from the move-only command API.
INSERT INTO "game_commands" ("game_id", "command_id", "kind", "version", "created_at")
SELECT "game_id", "command_id", 'move', "version", "created_at" FROM "moves";
