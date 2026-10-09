CREATE TABLE "game_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"user_id" uuid,
	"guest_session_id" uuid,
	CONSTRAINT "game_slots_identity_check" CHECK (num_nonnulls("game_slots"."user_id", "game_slots"."guest_session_id") = 1),
	CONSTRAINT "game_slots_scope_check" CHECK ("game_slots"."scope" in ('ordinary', 'sandbox') and ("game_slots"."scope" = 'ordinary' or "game_slots"."guest_session_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "game_slots" ADD CONSTRAINT "game_slots_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_slots" ADD CONSTRAINT "game_slots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_slots" ADD CONSTRAINT "game_slots_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_slots_game_idx" ON "game_slots" USING btree ("game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_slots_account_scope_unique" ON "game_slots" USING btree ("user_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "game_slots_guest_scope_unique" ON "game_slots" USING btree ("guest_session_id","scope");