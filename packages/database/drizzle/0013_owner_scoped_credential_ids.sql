ALTER TABLE "provider_credentials" DROP CONSTRAINT "provider_credentials_pkey";--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_id_pk" PRIMARY KEY("user_id","id");
