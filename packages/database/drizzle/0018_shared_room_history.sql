CREATE TABLE "room_history_access" (
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "room_history_access_game_id_user_id_pk" PRIMARY KEY("game_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "room_history_access" ADD CONSTRAINT "room_history_access_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_history_access" ADD CONSTRAINT "room_history_access_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_history_access_user_idx" ON "room_history_access" USING btree ("user_id","game_id");
--> statement-breakpoint
INSERT INTO "room_history_access" ("game_id", "user_id")
SELECT DISTINCT p."game_id", p."user_id"
FROM "game_participants" p JOIN "games" g ON g."id" = p."game_id"
WHERE g."mode" = 'human_vs_human' AND p."user_id" IS NOT NULL;
