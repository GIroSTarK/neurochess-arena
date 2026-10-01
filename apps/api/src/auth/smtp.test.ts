import { afterEach, describe, expect, it } from "vitest";

import { createSmtpMailbox } from "../../test/smtp-mailbox.js";
import { parseApiEnvironment } from "../env.js";

import { createAuthEmailSender } from "./smtp.js";

const mailboxes: Awaited<ReturnType<typeof createSmtpMailbox>>[] = [];
afterEach(async () => {
  await Promise.all(mailboxes.splice(0).map((mailbox) => mailbox.close()));
});

const base = {
  NODE_ENV: "test",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "smtp-fixture-secret-not-for-deployment",
  DATABASE_URL: "postgresql://localhost/neurochess",
};
const message = {
  to: "recipient@example.com",
  subject: "Account verification",
  text: "Open https://localhost/verify?token=test-only",
};

async function setup(reject = false, security = "none") {
  const mailbox = await createSmtpMailbox(reject);
  mailboxes.push(mailbox);
  const sender = createAuthEmailSender(
    parseApiEnvironment({
      ...base,
      AUTH_EMAIL_TRANSPORT: "smtp",
      AUTH_EMAIL_FROM: "accounts@example.com",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(mailbox.port),
      SMTP_SECURITY: security,
    }),
  );
  return { mailbox, sender: sender! };
}

describe("SMTP authentication email sender", () => {
  it("delivers the localized message to the configured SMTP server", async () => {
    const { mailbox, sender } = await setup();
    await sender.send(message);
    expect(mailbox.messages).toHaveLength(1);
    expect(mailbox.messages[0]).toContain("From: accounts@example.com");
    expect(mailbox.messages[0]).toContain("To: recipient@example.com");
    expect(mailbox.messages[0]).toContain("Subject: Account verification");
    expect(mailbox.messages[0]).toContain("https://localhost/verify");
  });

  it("rejects SMTP failures without retaining raw server responses", async () => {
    const { mailbox, sender } = await setup(true);
    const error = await sender.send(message).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: Authentication email delivery failed");
    expect(mailbox.messages).toHaveLength(0);
  });

  it("requires STARTTLS when configured and does not downgrade to plaintext", async () => {
    const { mailbox, sender } = await setup(false, "starttls");
    await expect(sender.send(message)).rejects.toThrow("Authentication email delivery failed");
    expect(mailbox.messages).toHaveLength(0);
  });

  it("does not create a hidden test mailbox when delivery is disabled", () => {
    expect(createAuthEmailSender(parseApiEnvironment(base))).toBeUndefined();
  });
});
