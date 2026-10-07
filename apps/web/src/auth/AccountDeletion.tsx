import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { authHref } from "../app/route-urls";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import { useRequiredAccount } from "./context";

export function AccountDeletion() {
  const { t } = useTranslation();
  const { commands, state } = useRequiredAccount();
  const pending = useRef(false);
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
        <Link
          className="inline-flex min-h-target items-center text-accent underline"
          to={authHref("sign-in", "/")}
        >
          {t("account.deletion.signIn")}
        </Link>
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
            <Button
              variant="danger"
              aria-disabled={commands.state !== "idle"}
              onClick={() => {
                if (pending.current || commands.state !== "idle" || !state.session) return;
                pending.current = true;
                void commands
                  .submit(
                    {
                      intent: "delete-account",
                      confirm: "true",
                      expectedAccount: state.session.user.id,
                    },
                    { method: "post", action: "/account" },
                  )
                  .finally(() => {
                    pending.current = false;
                  });
              }}
            >
              {t("account.deletion.confirm")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
