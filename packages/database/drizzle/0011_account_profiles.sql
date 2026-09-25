CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"username" text,
	"username_normalized" text,
	"avatar_preference" text DEFAULT 'provider' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_username_valid" CHECK ((
    ("profiles"."username" is null and "profiles"."username_normalized" is null) or
    ("profiles"."username" is not null and "profiles"."username_normalized" is not null
      and length("profiles"."username") between 3 and 24
      and "profiles"."username" collate "C" ~ '^[A-Za-z][A-Za-z0-9_]*$'
      and "profiles"."username_normalized" = translate("profiles"."username", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
      and "profiles"."username_normalized" not in ('admin', 'administrator', 'api', 'auth', 'guest', 'help', 'moderator', 'neurochess', 'root', 'sandbox', 'security', 'support', 'system', 'www'))
  )),
	CONSTRAINT "profiles_avatar_preference_valid" CHECK ("profiles"."avatar_preference" in ('provider', 'initials'))
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_username_normalized_unique" ON "profiles" USING btree ("username_normalized");