export type GameTarget =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "game"; readonly gameId: string };

export type AppPage = "arena" | "account" | "history" | "sandbox" | "reference" | "not-found";
export type AccountPage = "arena" | "history" | "profile" | "credentials" | "auth";
