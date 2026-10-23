import type { CredentialCatalogState } from "../credentials/catalog";
import type { PublicAccess, ScopedRouteData } from "../routing/route-runtime";
import type { SetupEntry } from "../setup/controller";

import type { MatchEntry } from "./controller";

export type MatchRouteEntry =
  | (SetupEntry & { readonly kind: "setup" })
  | Exclude<MatchEntry, { kind: "setup" }>
  | { readonly kind: "handoff"; readonly gameId: string };
export type MatchRouteData = ScopedRouteData<{
  readonly access: PublicAccess;
  readonly entry: MatchRouteEntry | null;
  readonly credentials: CredentialCatalogState | null;
}>;
