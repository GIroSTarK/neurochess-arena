ALTER TABLE "game_participants" DROP CONSTRAINT "game_participants_identity_check";--> statement-breakpoint
ALTER TABLE "games" ALTER COLUMN "owner_guest_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "game_participants" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_participants_user_unique" ON "game_participants" USING btree ("game_id","user_id");--> statement-breakpoint
CREATE INDEX "game_participants_user_idx" ON "game_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "games_owner_user_idx" ON "games" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "games_one_unfinished_per_account" ON "games" USING btree ("owner_user_id") WHERE "games"."state" in ('active', 'paused');--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_identity_check" CHECK (num_nonnulls("game_participants"."guest_session_id", "game_participants"."user_id") <= 1
        and ("game_participants"."seat_type" = 'human' or ("game_participants"."guest_session_id" is null and "game_participants"."user_id" is null)));--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_owner_check" CHECK (num_nonnulls("games"."owner_guest_session_id", "games"."owner_user_id") = 1);--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_sandbox_owner_check" CHECK (not "games"."is_sandbox" or "games"."owner_user_id" is null);