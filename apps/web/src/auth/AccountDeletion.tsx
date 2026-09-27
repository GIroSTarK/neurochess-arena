import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import { useRequiredAccount } from "./context";

export function AccountDeletion() {
  const { t } = useTranslation();
  const { controller } = useRequiredAccount();
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="grid gap-3 border-t border-divider pt-5">
      <h2 className="text-section font-semibold">{t("auth.deletion.title")}</h2>
      <p className="text-label text-text-secondary">{t("auth.deletion.hint")}</p>
      <Button variant="quiet-danger" onClick={() => setConfirming(true)}>
        {t("auth.deletion.action")}
      </Button>
      {confirming ? (
        <Dialog
          title={t("auth.deletion.confirmTitle")}
          description={t("auth.deletion.scope")}
          onCancel={() => setConfirming(false)}
        >
          <p className="mt-3 text-text-secondary">{t("auth.deletion.recheck")}</p>
          <p className="mt-3 text-text-secondary">{t("auth.deletion.retention")}</p>
          <p className="mt-3 text-text-secondary">{t("auth.deletion.limits")}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("auth.deletion.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void controller.deleteAccount()}>
              {t("auth.deletion.action")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
