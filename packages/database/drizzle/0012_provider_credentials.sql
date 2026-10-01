CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"masked_suffix" text,
	"version" integer NOT NULL,
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"auth_tag" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credentials_provider_valid" CHECK ("provider_credentials"."provider" in ('openai', 'anthropic', 'google', 'openrouter')),
	CONSTRAINT "provider_credentials_label_valid" CHECK (char_length("provider_credentials"."label") between 1 and 64 and "provider_credentials"."label" = btrim("provider_credentials"."label") and "provider_credentials"."label" !~ '[[:cntrl:]]'),
	CONSTRAINT "provider_credentials_suffix_valid" CHECK ("provider_credentials"."masked_suffix" is null or "provider_credentials"."masked_suffix" collate "C" ~ '^[A-Za-z0-9_-]{4}$'),
	CONSTRAINT "provider_credentials_envelope_valid" CHECK ("provider_credentials"."version" = 1
    and char_length("provider_credentials"."key_id") between 1 and 64 and "provider_credentials"."key_id" collate "C" ~ '^[A-Za-z0-9_-]+$'
    and "provider_credentials"."nonce" collate "C" ~ '^[a-f0-9]{24}$'
    and "provider_credentials"."auth_tag" collate "C" ~ '^[a-f0-9]{32}$'
    and char_length("provider_credentials"."ciphertext") between 2 and 8192 and "provider_credentials"."ciphertext" collate "C" ~ '^([a-f0-9]{2})+$')
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_credentials_owner_created_idx" ON "provider_credentials" USING btree ("user_id","created_at","id");