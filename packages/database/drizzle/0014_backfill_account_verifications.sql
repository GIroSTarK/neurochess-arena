-- Custom SQL migration file, put your code below! --
-- Older writers must be stopped before this backfill and the ownership-aware API restart.
UPDATE "verification" AS v SET "user_id" = u."id"
FROM "user" AS u
WHERE v."identifier" LIKE 'reset-password:%' AND v."value" = u."id";
--> statement-breakpoint
UPDATE "verification" AS v SET "user_id" = u."id"
FROM "user" AS u
WHERE CASE WHEN v."value" IS JSON OBJECT THEN v."value"::jsonb #>> '{link,userId}' END = u."id";
--> statement-breakpoint
DELETE FROM "verification"
WHERE "user_id" IS NULL AND (
  "identifier" LIKE 'reset-password:%'
  OR CASE WHEN "value" IS JSON OBJECT THEN "value"::jsonb #>> '{link,userId}' END IS NOT NULL
);
