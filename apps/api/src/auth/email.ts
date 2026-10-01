import type { ApiEnvironment } from "../env.js";
import { authEmailMessages } from "../locales/en.js";

import { AUTH_BASE_PATH } from "./constants.js";

export interface AuthEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface AuthEmailSender {
  send(message: AuthEmail): Promise<void>;
}

export function authEmail(
  environment: Pick<ApiEnvironment, "WEB_ORIGIN" | "BETTER_AUTH_URL">,
  purpose: "verification" | "reset",
  email: string,
  token: string,
): AuthEmail {
  const url =
    purpose === "verification"
      ? new URL(`${AUTH_BASE_PATH}/verify-email`, environment.BETTER_AUTH_URL)
      : new URL("/auth/reset-password", environment.WEB_ORIGIN);
  if (purpose === "verification") url.searchParams.set("token", token);
  else url.hash = new URLSearchParams({ token }).toString();
  const messages = authEmailMessages[purpose];
  return { to: email, subject: messages.subject, text: messages.text(url.href) };
}
