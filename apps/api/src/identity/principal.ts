// Server-derived identity only; credentials stay in the authentication/request boundary.
export interface GuestPrincipal {
  readonly kind: "guest";
  readonly guestSessionId: string;
}

export interface AccountPrincipal {
  readonly kind: "account";
  readonly userId: string;
}

// Gameplay remains guest-only until account ownership, locks, and seats ship together.
export type Principal = GuestPrincipal;

export function isGuestPrincipal(principal: { readonly kind: string }): boolean {
  return principal.kind === "guest";
}
