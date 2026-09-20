CREATE TABLE "ai_controllers" (
	"game_id" uuid PRIMARY KEY NOT NULL,
	"controller_id" uuid,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_controllers" ADD CONSTRAINT "ai_controllers_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_controllers_expiry_idx" ON "ai_controllers" USING btree ("expires_at");