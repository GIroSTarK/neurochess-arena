export interface GuestPrincipal {
  readonly kind: "guest";
  readonly guestSessionId: string;
}

// Extend this union only with identities resolved by a server authenticator.
// A principal identifies the caller; it does not prove the session is still valid.
export type Principal = GuestPrincipal;
