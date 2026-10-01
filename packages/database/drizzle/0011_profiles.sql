CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" text,
	"username_normalized" text,
	"avatar_removed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_username_valid" CHECK (
    ("profiles"."username" is null and "profiles"."username_normalized" is null) or
    ("profiles"."username" is not null and "profiles"."username_normalized" is not null
      and "profiles"."username" collate "C" ~ '^[A-Za-z0-9_]{3,24}$'
      and "profiles"."username_normalized" = lower("profiles"."username" collate "C")
      and "profiles"."username_normalized" not in (
        'admin', 'administrator', 'api', 'arena', 'auth', 'guest', 'help', 'login',
        'logout', 'moderator', 'neurochess', 'root', 'security', 'support', 'system', 'www'
      )))
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_username_normalized_unique" ON "profiles" USING btree ("username_normalized");