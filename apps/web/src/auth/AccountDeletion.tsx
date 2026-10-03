import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import { useRequiredAccount } from "./context";
import { authHref } from "./navigation";

export function AccountDeletion() {
  const { t } = useTranslation();
  const { controller, state } = useRequiredAccount();
  const [confirming, setConfirming] = useState(false);
  return (
    <section
      className="grid gap-3 border-t border-divider pt-6"
      aria-label={t("account.deletion.title")}
    >
      <h2 className="text-section font-semibold">{t("account.deletion.title")}</h2>
      <p className="text-text-secondary">{t("account.deletion.hint")}</p>
      {state.deletion === "uncertain" ? (
        <p role="alert">{t("account.deletion.uncertain")}</p>
      ) : null}
      {state.issue === "AUTH_REAUTH_REQUIRED" ? (
        <a
          className="inline-flex min-h-target items-center text-accent underline"
          href={authHref("sign-in", "/")}
        >
          {t("account.deletion.signIn")}
        </a>
      ) : null}
      <Button variant="danger" onClick={() => setConfirming(true)}>
        {t("account.deletion.title")}
      </Button>
      {confirming ? (
        <Dialog
          title={t("account.deletion.title")}
          description={t("account.deletion.description")}
          onCancel={() => setConfirming(false)}
        >
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("actions.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void controller.deleteAccount()}>
              {t("account.deletion.confirm")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
