import { z } from "zod";

const linkingState = z.object({ link: z.object({ userId: z.string().min(1) }) });

export function verificationOwner(record: { identifier: string; value: string }): string | null {
  if (record.identifier.startsWith("reset-password:")) return record.value;
  try {
    const parsed = linkingState.safeParse(JSON.parse(record.value));
    return parsed.success ? parsed.data.link.userId : null;
  } catch {
    return null;
  }
}
