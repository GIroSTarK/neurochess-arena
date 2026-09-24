import { authEmailSchema, authVerifyEmailRequestSchema } from "@neurochess/contracts";
import nodemailer from "nodemailer";

import type { ApiEnvironment } from "../env.js";
import { authEmailMessages } from "../locales/en.js";

import { AuthRequestError } from "./errors.js";

export interface AuthEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface AuthEmailSender {
  send(message: AuthEmail): Promise<void>;
}

export function createSmtpEmailSender(environment: ApiEnvironment): AuthEmailSender | undefined {
  if (environment.AUTH_EMAIL_TRANSPORT === "disabled") return undefined;
  const transport = nodemailer.createTransport({
    host: environment.SMTP_HOST,
    port: environment.SMTP_PORT,
    secure: environment.SMTP_SECURITY === "tls",
    requireTLS: environment.SMTP_SECURITY === "starttls",
    ignoreTLS: environment.SMTP_SECURITY === "none",
    ...(environment.SMTP_USER
      ? { auth: { user: environment.SMTP_USER, pass: environment.SMTP_PASSWORD } }
      : {}),
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(message) {
      try {
        const to = authEmailSchema.parse(message.to);
        const result = await transport.sendMail({
          from: environment.AUTH_EMAIL_FROM,
          to,
          subject: message.subject,
          text: message.text,
        });
        if (result.accepted.length !== 1 || result.rejected.length) throw new Error();
      } catch {
        throw new AuthRequestError(503, "AUTH_EMAIL_UNAVAILABLE");
      }
    },
  };
}

export async function sendAuthEmail(
  sender: AuthEmailSender,
  webOrigin: string,
  kind: keyof typeof authEmailMessages,
  email: string,
  token: string,
): Promise<void> {
  const to = authEmailSchema.parse(email);
  authVerifyEmailRequestSchema.parse({ token });
  // Fixed destinations exclude caller-controlled redirects; fragments never enter HTTP/referrers.
  const url = new URL(
    kind === "verification" ? "/auth/verify-email" : "/auth/reset-password",
    webOrigin,
  );
  url.hash = new URLSearchParams({ token }).toString();
  const copy = authEmailMessages[kind];
  try {
    await sender.send({ to, subject: copy.subject, text: copy.text(url.href) });
  } catch {
    throw new AuthRequestError(503, "AUTH_EMAIL_UNAVAILABLE");
  }
}
