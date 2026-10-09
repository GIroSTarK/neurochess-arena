import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function issueInvitation() {
  const invitation = randomBytes(32).toString("base64url");
  return { invitation, digest: invitationDigest(invitation) };
}

export function invitationDigest(invitation: string): string {
  return createHash("sha256").update(invitation).digest("hex");
}

export function matchesInvitation(digest: string, stored: string | null): boolean {
  return (
    stored !== null &&
    /^[0-9a-f]{64}$/.test(stored) &&
    timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(stored, "hex"))
  );
}
