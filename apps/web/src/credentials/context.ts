import { createContext, useContext } from "react";

import type { CredentialController, CredentialState } from "./controller";

export const CredentialContext = createContext<{
  controller: CredentialController;
  state: CredentialState;
} | null>(null);
export const useCredentials = () => useContext(CredentialContext);
