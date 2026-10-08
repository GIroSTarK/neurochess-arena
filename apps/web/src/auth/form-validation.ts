import {
  authEmailRequestSchema,
  authPasswordSchema,
  authSignInRequestSchema,
} from "@neurochess/contracts";

import type { AuthForm } from "../routing/route-urls";

export function authFormInvalid(kind: AuthForm, email: string, password: string) {
  if (kind !== "reset-password" && !authEmailRequestSchema.safeParse({ email }).success) {
    return "email";
  }
  if (
    ((kind === "sign-up" || kind === "reset-password") &&
      !authPasswordSchema.safeParse(password).success) ||
    (kind === "sign-in" && !authSignInRequestSchema.safeParse({ email, password }).success)
  ) {
    return "password";
  }
  return null;
}
