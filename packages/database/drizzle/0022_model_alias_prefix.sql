ALTER TABLE "game_participants" DROP CONSTRAINT "game_participants_model_id_check";--> statement-breakpoint
ALTER TABLE "model_invocations" DROP CONSTRAINT "model_invocations_model_id_check";--> statement-breakpoint
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_model_id_check" CHECK ("game_participants"."model_id" is null or (length("game_participants"."model_id") between 1 and 256
        and "game_participants"."model_id" ~ '^~?[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$'));--> statement-breakpoint
ALTER TABLE "model_invocations" ADD CONSTRAINT "model_invocations_model_id_check" CHECK (length("model_invocations"."model_id") between 1 and 256 and "model_invocations"."model_id" ~ '^~?[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$');