import { createContext, useContext } from "react";
import type { FetcherWithComponents } from "react-router";

import type { AccountActionData } from "./action-data";
import type { AccountController, AccountState } from "./controller";

export const AccountContext = createContext<{
  controller: AccountController;
  state: AccountState;
  commands: FetcherWithComponents<AccountActionData>;
  profileCommands: FetcherWithComponents<AccountActionData>;
} | null>(null);
export const useAccount = () => useContext(AccountContext);

export function useRequiredAccount() {
  const account = useAccount();
  if (!account) throw new Error("ACCOUNT_CONTEXT_MISSING");
  return account;
}
