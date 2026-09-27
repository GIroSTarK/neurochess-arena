import { createHmac } from "node:crypto";

import {
  createAccountRepository,
  currentAuthTransaction,
  type DatabaseConnection,
} from "@neurochess/database";
import type { ValidateUserInfoAction } from "better-auth";
import { z } from "zod";

const timestamp = z.iso.datetime({ precision: 6 });
const googleSubject = z.object({ sub: z.string().min(1).max(255) });
const githubSubject = z.object({ id: z.int().positive() });

export function createOAuthDeletionFence(database: DatabaseConnection, secret: string) {
  const accounts = createAccountRepository(database);
  const fingerprint = (provider: string, subject: string) =>
    createHmac("sha256", secret)
      .update(JSON.stringify(["neurochess/account-deletion", 1, provider, subject]))
      .digest("hex");
  return {
    fingerprint,
    start: () => accounts.oauthStartedAt(),
    cleanup: () => accounts.cleanupDeletionMarkers(),
    async allows(
      provider: string,
      profile: unknown,
      email: string,
      startedAt: unknown,
      action: ValidateUserInfoAction,
    ) {
      const started = timestamp.safeParse(startedAt);
      const subject =
        provider === "google" ? googleSubject.safeParse(profile) : githubSubject.safeParse(profile);
      if (!started.success || !subject.success) return false;
      const id = "sub" in subject.data ? subject.data.sub : String(subject.data.id);
      const identifiers = [fingerprint(provider, id), fingerprint("email", email.toLowerCase())];
      if (action !== "create-user") {
        // Sign-in and linking write rows referencing the existing user, which deletion locks and
        // removes; those writes fail on the foreign key once deletion commits.
        return accounts.allowsOAuth(identifiers, started.data);
      }
      // Creation references no existing row. Check inside the identity write's transaction so the
      // fence lock outlives the write, and fail closed should the library ever create outside one.
      const transaction = currentAuthTransaction();
      return (
        transaction !== undefined && accounts.allowsOAuth(identifiers, started.data, transaction)
      );
    },
  };
}
export type OAuthDeletionFence = ReturnType<typeof createOAuthDeletionFence>;
