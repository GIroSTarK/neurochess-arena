// Server-derived identity only; credentials stay in the authentication/request boundary.
export interface GuestPrincipal {
  readonly kind: "guest";
  readonly guestSessionId: string;
}

// Add an account variant only alongside validated account sessions and ownership support.
export type Principal = GuestPrincipal;

export function isGuestPrincipal(principal: { readonly kind: string }): boolean {
  return principal.kind === "guest";
}
