ALTER TYPE "public"."ai_game_mode" ADD VALUE 'human_vs_human';--> statement-breakpoint
CREATE TABLE "room_creation_operations" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"owner_color" "chess_color",
	"game_id" uuid,
	CONSTRAINT "room_creation_operations_expiry_check" CHECK ("room_creation_operations"."expires_at" = "room_creation_operations"."issued_at" + interval '10 minutes'),
	CONSTRAINT "room_creation_operations_state_check" CHECK (
    ("room_creation_operations"."state" = 'pending' and "room_creation_operations"."owner_color" is null and "room_creation_operations"."game_id" is null)
    or ("room_creation_operations"."state" = 'consumed' and "room_creation_operations"."owner_color" is not null))
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"game_id" uuid PRIMARY KEY NOT NULL,
	"owner_color" "chess_color" NOT NULL,
	"state" text NOT NULL,
	"invitation_digest" text,
	"joined_at" timestamp with time zone,
	CONSTRAINT "rooms_invitation_digest_check" CHECK ("rooms"."invitation_digest" is null or "rooms"."invitation_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rooms_admission_check" CHECK (
    ("rooms"."state" = 'waiting' and "rooms"."joined_at" is null)
    or ("rooms"."state" = 'joined' and "rooms"."joined_at" is not null and "rooms"."invitation_digest" is null))
);
--> statement-breakpoint
ALTER TABLE "games" DROP CONSTRAINT "games_owner_check";--> statement-breakpoint
ALTER TABLE "room_creation_operations" ADD CONSTRAINT "room_creation_operations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_creation_operations" ADD CONSTRAINT "room_creation_operations_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_creation_operations_id_unique" ON "room_creation_operations" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_invitation_digest_unique" ON "rooms" USING btree ("invitation_digest");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_owner_check" CHECK (case when "games"."mode"::text = 'human_vs_human'
        then "games"."owner_guest_session_id" is null
          and ("games"."owner_user_id" is not null or "games"."state" in ('completed', 'aborted'))
        else num_nonnulls("games"."owner_guest_session_id", "games"."owner_user_id") = 1 end);