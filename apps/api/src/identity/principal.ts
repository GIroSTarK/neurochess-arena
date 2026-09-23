export interface GuestPrincipal {
  readonly kind: "guest";
  readonly guestSessionId: string;
}

export interface AccountPrincipal {
  readonly kind: "account";
  readonly userId: string;
  readonly sessionId: string;
}

// A principal identifies the caller; it does not prove the session is still valid.
export type Principal = GuestPrincipal | AccountPrincipal;
