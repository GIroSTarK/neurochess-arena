// Server-derived identity only; credentials stay in the authentication/request boundary.
export interface GuestPrincipal {
  readonly kind: "guest";
  readonly guestSessionId: string;
}

export interface AccountIdentity {
  readonly kind: "account";
  readonly userId: string;
}

export interface AccountPrincipal extends AccountIdentity {
  readonly sessionId: string;
}

export type GameIdentity = GuestPrincipal | AccountIdentity;
export type Principal = GuestPrincipal | AccountPrincipal;

export function isGuestPrincipal(principal: GameIdentity): principal is GuestPrincipal {
  return principal.kind === "guest";
}
