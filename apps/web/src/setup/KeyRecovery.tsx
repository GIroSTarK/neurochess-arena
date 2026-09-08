import {
  type AiGameConfiguration,
  type ChessColor,
  type SessionCredential,
  sessionCredentialSchema,
} from "@neurochess/contracts";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import { fieldClass } from "./ModelPicker";

export function KeyRecovery({
  match,
  missing,
  onCredential,
  rejected = false,
  corrected = false,
  disabled = false,
}: {
  readonly match: AiGameConfiguration;
  readonly missing: readonly ChessColor[];
  readonly onCredential: (color: ChessColor, credential: SessionCredential) => void;
  readonly rejected?: boolean;
  readonly corrected?: boolean;
  readonly disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, []);
  return (
    <div className="space-y-3 rounded-panel border border-warning bg-surface p-4">
      <p role="status" className="text-warning">
        {t(
          rejected
            ? corrected
              ? "keyRecovery.corrected"
              : "keyRecovery.rejected"
            : "keyRecovery.description",
        )}
      </p>
      <Button variant="secondary" aria-disabled={disabled} onClick={() => setOpen(true)}>
        {t(rejected ? "keyRecovery.update" : "keyRecovery.enter")}
      </Button>
      {open ? (
        <KeyDialog
          match={match}
          missing={missing}
          onCancel={() => setOpen(false)}
          onCredential={onCredential}
          rejected={rejected}
        />
      ) : null}
    </div>
  );
}

function KeyDialog({
  match,
  missing,
  onCancel,
  onCredential,
  rejected,
}: {
  readonly match: AiGameConfiguration;
  readonly missing: readonly ChessColor[];
  readonly onCancel: () => void;
  readonly onCredential: (color: ChessColor, credential: SessionCredential) => void;
  readonly rejected: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [keys, setKeys] = useState<Partial<Record<ChessColor, string>>>({});
  const [revealed, setRevealed] = useState<Partial<Record<ChessColor, boolean>>>({});
  const seats = missing.map((color) => ({
    color,
    configuration: match.mode === "ai_vs_ai" ? match[color] : match.ai,
  }));
  const ready = seats.every(
    ({ color, configuration }) =>
      sessionCredentialSchema.safeParse({
        provider: configuration.provider,
        apiKey: keys[color] ?? "",
      }).success,
  );
  return (
    <Dialog
      title={t(rejected ? "keyRecovery.updateTitle" : "keyRecovery.title")}
      description={t("keyRecovery.hint")}
      onCancel={onCancel}
    >
      <form
        className="mt-4 space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          for (const { color, configuration } of seats) {
            onCredential(color, { provider: configuration.provider, apiKey: keys[color] ?? "" });
          }
          onCancel();
        }}
      >
        {seats.map(({ color, configuration }) => (
          <div key={color}>
            <label htmlFor={`${id}-${color}`} className="mb-2 block text-label font-semibold">
              {t("keyRecovery.seatKey", {
                color: t(`players.${color}`),
                provider: configuration.provider,
              })}
            </label>
            <p className="mb-2 text-label wrap-anywhere text-text-secondary">
              {configuration.modelId}
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                id={`${id}-${color}`}
                type={revealed[color] ? "text" : "password"}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={4096}
                required
                value={keys[color] ?? ""}
                className={`${fieldClass} flex-[1_1_12rem]`}
                onChange={(event) =>
                  setKeys((previous) => ({ ...previous, [color]: event.target.value }))
                }
              />
              <Button
                variant="secondary"
                aria-pressed={Boolean(revealed[color])}
                aria-disabled={!keys[color]}
                onClick={() =>
                  setRevealed((previous) => ({ ...previous, [color]: !previous[color] }))
                }
              >
                {t(revealed[color] ? "setup.hideKey" : "setup.showKey")}
              </Button>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={onCancel}>
            {t("actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" aria-disabled={!ready}>
            {t("keyRecovery.apply")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
