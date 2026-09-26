import { createHmac } from "node:crypto";

import { createAccountRepository, type DatabaseConnection } from "@neurochess/database";
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
    async allows(provider: string, profile: unknown, email: string, startedAt: unknown) {
      const started = timestamp.safeParse(startedAt);
      const subject =
        provider === "google" ? googleSubject.safeParse(profile) : githubSubject.safeParse(profile);
      if (!started.success || !subject.success) return false;
      const id = "sub" in subject.data ? subject.data.sub : String(subject.data.id);
      return accounts.allowsOAuth(
        [fingerprint(provider, id), fingerprint("email", email.toLowerCase())],
        started.data,
      );
    },
  };
}
export type OAuthDeletionFence = ReturnType<typeof createOAuthDeletionFence>;
