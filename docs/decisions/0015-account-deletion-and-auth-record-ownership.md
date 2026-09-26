# ADR-0015: Atomic account deletion and owned authentication records

**Status:** Accepted

**Date:** 2026-09-27

## Context

The [account deletion contract](../product.md#private-history-and-deletion) includes unfinished games, credentials, profiles and authentication data. Better Auth's built-in deletion does not clean application games, and its verification table has no user relation by default. Reset-token creation can race deletion. Its default signed email-verification token identifies an email address, which could later belong to a newly registered account.

## Decision

- Expose one confirmed application endpoint within the existing Better Auth boundary; retain disabled/blocked built-in deletion. Use authoritative session lookup and the existing one-hour fresh-session policy for every sign-in method. Reauthentication and confirmation are separate actions.
- Reuse ADR-0013's user-before-session ordering. Delete owned public AI games and then the user in one PostgreSQL transaction, checking expiry/freshness after lock waits. Existing game cascades and auth/application user cascades remove dependent data atomically. Retain restricting game/seat foreign keys for future shared-human data until Phase 4 defines retention.
- Add a nullable user foreign key to Better Auth verification records. Server hooks assign it to password-reset records and explicit OAuth-link state. The FK rejects issuance after deletion and cascades records issued first. Backfill populated schemas with old writers stopped; anonymous OAuth sign-in state is not account data.
- Sign email-verification tokens through Better Auth with the immutable user ID as `sub`. A Better Auth hook validates the signature/expiry and performs a single update constrained by both ID and email. It never creates sessions or changes email. Earlier unbound links require a resend after rollout.
- Preserve all existing command/controller/reservation authorization checks. They serialize at the same user lock, and deleted games are never upserted by late results or cleanup. Provider calls remain outside transactions.
- Bind confirmation to the displayed account ID, comparing it with the independent Better Auth identity before cleanup. It is a consistency check, never client-selected authority.
- Retain the user-approved ten-minute OAuth deletion markers: HMAC-SHA-256 of the UTF-8 JSON tuple `["neurochess/account-deletion", 1, provider, subject]`, keyed by the auth secret. Use `"email"` for the lowercase local email and `"google"`/`"github"` for linked stable provider subjects. Store only the hash, database-clock cutoff and expiry in a dedicated table. Reject matching older OAuth flows and enforce the full ten-minute flow lifetime again at identity admission, including after network waits. Newly initiated flows may create a new empty account.

## Consequences

Success means live account-data cleanup and the temporary OAuth fence committed, and every old account session is invalid. Failure rolls back; transport uncertainty is reported without a deletion claim. Browser lifetimes and page-owned secrets end on submission, and other devices detect loss through the existing session boundary. No deletion job or partially active account is introduced. Markers expire after ten minutes and are removed on startup and the next minute's sweep; downtime or database unavailability can delay physical cleanup. This limited pseudonymous retention was explicitly approved for preventing late account recreation.

Verification/reset tokens cannot authorize a recreated email identity. Fresh-session checks require users to sign in again after one hour. Previously issued email-verification links must be replaced at rollout. Deletion cannot retract already-dispatched provider work, delivered/downloaded copies or external backups. Backup retention and shared-human-game semantics remain separate decisions.

## Alternatives considered

- **Enable built-in deletion with a cleanup hook:** application cleanup and auth deletion would not share one proven atomic boundary; alternate callbacks could bypass the complete flow.
- **Delete tokens by value after user deletion:** lacks a foreign-key fence against concurrent issuance and cannot safely treat all verification purposes as user IDs.
- **Only check email token expiry:** allows a still-valid old link to verify a different account registered at the same address.
- **Permanent tombstones/background deletion jobs:** unnecessary for the current relational cleanup. Only temporary keyed-hash markers are retained to fence pending anonymous OAuth work, whose target is unknown when it starts.
