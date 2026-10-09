-- Stop old API writers before applying the slot schema and backfill together.
-- Keep the existing owner indexes; conflicting legacy participation must fail the upgrade.
LOCK TABLE "games", "game_participants" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO "game_slots" ("game_id", "scope", "user_id", "guest_session_id")
SELECT "id", CASE WHEN "is_sandbox" THEN 'sandbox' ELSE 'ordinary' END,
       "owner_user_id", "owner_guest_session_id"
FROM "games"
WHERE "state" IN ('active', 'paused')
UNION
SELECT g."id", 'ordinary', p."user_id", p."guest_session_id"
FROM "games" g
JOIN "game_participants" p ON p."game_id" = g."id"
WHERE g."state" IN ('active', 'paused') AND NOT g."is_sandbox"
  AND p."seat_type" = 'human'
  AND num_nonnulls(p."user_id", p."guest_session_id") = 1;
