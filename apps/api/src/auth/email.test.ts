import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { parseApiEnvironment } from "../env.js";

import { createSmtpEmailSender, sendAuthEmail } from "./email.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function smtpMailbox(reject = false) {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost test mailbox\r\n");
    let pending = "";
    let data: string[] | undefined;
    socket.on("data", (chunk) => {
      pending += String(chunk);
      while (pending.includes("\r\n")) {
        const index = pending.indexOf("\r\n");
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        if (data) {
          if (line === ".") {
            messages.push(data.join("\r\n"));
            data = undefined;
            socket.write("250 queued\r\n");
          } else data.push(line);
        } else if (line.startsWith("EHLO")) socket.write("250-localhost\r\n250 8BITMIME\r\n");
        else if (line === "STARTTLS") socket.write("454 TLS unavailable\r\n");
        else if (line.startsWith("RCPT") && reject) {
          socket.write("550 rejected smtp-secret-canary\r\n");
        } else if (line === "DATA") {
          data = [];
          socket.write("354 send message\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP test server did not bind");
  return { messages, port: address.port };
}

function environment(port: number) {
  return parseApiEnvironment({
    NODE_ENV: "test",
    BETTER_AUTH_URL: "http://localhost:3001",
    BETTER_AUTH_SECRET: "test-only-email-auth-secret-1234567890",
    DATABASE_URL: "postgresql://test:test@localhost/email_test",
    AUTH_EMAIL_TRANSPORT: "smtp",
    AUTH_EMAIL_FROM: "accounts@example.test",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: port,
    SMTP_SECURITY: "none",
  });
}

describe("SMTP auth delivery", () => {
  it("delivers a localized text message through the real transport to an isolated SMTP mailbox", async () => {
    const mailbox = await smtpMailbox();
    const sender = createSmtpEmailSender(environment(mailbox.port))!;
    await sendAuthEmail(
      sender,
      "http://localhost:5173",
      "verification",
      "User@example.test",
      "test-token",
    );
    expect(mailbox.messages).toHaveLength(1);
    expect(mailbox.messages[0]).toContain("From: accounts@example.test");
    expect(mailbox.messages[0]).toContain("To: user@example.test");
    expect(mailbox.messages[0]).toContain("Subject: Verify your Neurochess Arena email");
    expect(mailbox.messages[0]?.replace(/=\r\n/g, "").replace(/=3D/g, "=")).toContain(
      "/auth/verify-email#token=test-token",
    );
    expect(mailbox.messages[0]).not.toContain("text/html");
  });

  it("does not acknowledge rejected recipients and never exposes SMTP error details", async () => {
    const mailbox = await smtpMailbox(true);
    const sender = createSmtpEmailSender(environment(mailbox.port))!;
    await expect(
      sendAuthEmail(sender, "http://localhost:5173", "reset", "user@example.test", "test-token"),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "AUTH_EMAIL_UNAVAILABLE",
      message: "AUTH_REQUEST_FAILED",
    });
    expect(mailbox.messages).toHaveLength(0);
  });

  it("requires STARTTLS when configured instead of falling back to plaintext", async () => {
    const mailbox = await smtpMailbox();
    const sender = createSmtpEmailSender({
      ...environment(mailbox.port),
      SMTP_SECURITY: "starttls",
    })!;
    await expect(
      sendAuthEmail(sender, "http://localhost:5173", "reset", "user@example.test", "test-token"),
    ).rejects.toMatchObject({ statusCode: 503, code: "AUTH_EMAIL_UNAVAILABLE" });
    expect(mailbox.messages).toHaveLength(0);
  });
});
