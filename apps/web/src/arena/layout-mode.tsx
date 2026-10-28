import { createContext, useContext } from "react";

export type ArenaLayoutMode = "stacked" | "wide";

export const ArenaLayoutContext = createContext<ArenaLayoutMode>("stacked");

export function useArenaLayoutMode(): ArenaLayoutMode {
  return useContext(ArenaLayoutContext);
}
