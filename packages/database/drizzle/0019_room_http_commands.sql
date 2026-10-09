ALTER TYPE "public"."game_command_kind" ADD VALUE 'room_join';--> statement-breakpoint
ALTER TYPE "public"."game_command_kind" ADD VALUE 'invitation_replace';--> statement-breakpoint
ALTER TYPE "public"."game_command_kind" ADD VALUE 'invitation_revoke';--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "join_command_id" uuid;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "joined_invitation_digest" text;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_join_command_unique" ON "rooms" USING btree ("join_command_id");--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_join_receipt_check" CHECK (
      ("rooms"."join_command_id" is null and "rooms"."joined_invitation_digest" is null)
      or ("rooms"."state" = 'joined' and "rooms"."join_command_id" is not null
        and "rooms"."joined_invitation_digest" is not null and "rooms"."joined_invitation_digest" ~ '^[0-9a-f]{64}$'));