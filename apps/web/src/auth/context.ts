import { createContext, useContext } from "react";

import type { AccountController, AccountState } from "./controller";

export const AccountContext = createContext<{
  controller: AccountController;
  state: AccountState;
} | null>(null);
export const useAccount = () => useContext(AccountContext);

export function useRequiredAccount() {
  const account = useAccount();
  if (!account) throw new Error("ACCOUNT_CONTEXT_MISSING");
  return account;
}
