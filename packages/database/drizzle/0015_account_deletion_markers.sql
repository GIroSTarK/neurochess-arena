CREATE TABLE "account_deletion_markers" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"cutoff" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_deletion_markers_fingerprint_check" CHECK ("account_deletion_markers"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "account_deletion_markers_expiry_check" CHECK ("account_deletion_markers"."expires_at" > "account_deletion_markers"."cutoff")
);
--> statement-breakpoint
CREATE INDEX "account_deletion_markers_expiry_idx" ON "account_deletion_markers" USING btree ("expires_at");