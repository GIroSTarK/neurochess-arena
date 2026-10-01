import { and, eq, gt, sql } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import { account, session, user } from "./schema/auth.js";
import { profiles } from "./schema/profiles.js";

interface ProfileIdentity {
  readonly userId: string;
  readonly sessionId: string;
}
interface ProfileChanges {
  readonly username?: string;
  readonly removeAvatar?: boolean;
}
type Executor = Pick<DatabaseConnection["db"], "select">;

class ProfileSessionExpiredError extends Error {}

export class UsernameTakenError extends Error {
  constructor() {
    super("Username is unavailable");
  }
}

async function readProfile(db: Executor, identity: ProfileIdentity) {
  const [record] = await db
    .select({
      username: profiles.username,
      usernameNormalized: profiles.usernameNormalized,
      avatarRemoved: profiles.avatarRemoved,
      image: user.image,
    })
    .from(user)
    .innerJoin(session, eq(session.userId, user.id))
    .leftJoin(profiles, eq(profiles.userId, user.id))
    .where(
      and(
        eq(user.id, identity.userId),
        eq(session.id, identity.sessionId),
        gt(session.expiresAt, sql`clock_timestamp() at time zone 'UTC'`),
      ),
    );
  if (!record) return undefined;
  const providers = await db
    .select({ provider: account.providerId })
    .from(account)
    .where(eq(account.userId, identity.userId));
  return { ...record, providers: providers.map((row) => row.provider) };
}

export type StoredProfile = NonNullable<Awaited<ReturnType<typeof readProfile>>>;
export interface ProfileRepository {
  read(identity: ProfileIdentity): Promise<StoredProfile | undefined>;
  update(identity: ProfileIdentity, changes: ProfileChanges): Promise<StoredProfile | undefined>;
}

export function createProfileRepository(database: DatabaseConnection): ProfileRepository {
  return {
    read: (identity) => readProfile(database.db, identity),
    async update(identity, changes) {
      try {
        return await database.db.transaction(async (tx) => {
          // Share the auth/game account lock so a queued update cannot outlive revocation.
          const [owner] = await tx
            .select({ id: user.id })
            .from(user)
            .where(eq(user.id, identity.userId))
            .for("update");
          if (!owner || !(await readProfile(tx, identity))) return undefined;
          const values = {
            ...(changes.username !== undefined
              ? {
                  username: changes.username,
                  usernameNormalized: changes.username.toLowerCase(),
                }
              : {}),
            ...(changes.removeAvatar ? { avatarRemoved: true } : {}),
            updatedAt: new Date(),
          };
          await tx
            .insert(profiles)
            .values({ userId: identity.userId, ...values })
            .onConflictDoUpdate({ target: profiles.userId, set: values });
          if (changes.removeAvatar) {
            await tx.update(user).set({ image: null }).where(eq(user.id, identity.userId));
          }
          const result = await readProfile(tx, identity);
          // A competing username claim can hold the unique-index write past expiry.
          // Throw inside the transaction so an unauthorized result never commits changes.
          if (!result) throw new ProfileSessionExpiredError();
          return result;
        });
      } catch (error) {
        if (error instanceof ProfileSessionExpiredError) return undefined;
        const cause = error instanceof Error ? error.cause : undefined;
        if (
          cause &&
          typeof cause === "object" &&
          "code" in cause &&
          cause.code === "23505" &&
          "constraint" in cause &&
          cause.constraint === "profiles_username_normalized_unique"
        ) {
          throw new UsernameTakenError();
        }
        throw error;
      }
    },
  };
}
