import nodemailer from "nodemailer";

import type { ApiEnvironment } from "../env.js";

import type { AuthEmailSender } from "./email.js";

export function createAuthEmailSender(environment: ApiEnvironment): AuthEmailSender | undefined {
  if (environment.AUTH_EMAIL_TRANSPORT === "disabled") return undefined;
  const transport = nodemailer.createTransport({
    host: environment.SMTP_HOST,
    port: environment.SMTP_PORT,
    secure: environment.SMTP_SECURITY === "tls",
    requireTLS: environment.SMTP_SECURITY === "starttls",
    ignoreTLS: environment.SMTP_SECURITY === "none",
    ...(environment.SMTP_USER && environment.SMTP_PASSWORD
      ? {
          auth: { user: environment.SMTP_USER, pass: environment.SMTP_PASSWORD },
        }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(message) {
      try {
        const result = await transport.sendMail({ ...message, from: environment.AUTH_EMAIL_FROM });
        if (!result.accepted.includes(message.to) || result.rejected.length) throw new Error();
      } catch {
        // SMTP errors can embed credentials, recipients and message content.
        throw new Error("Authentication email delivery failed");
      }
    },
  };
}
