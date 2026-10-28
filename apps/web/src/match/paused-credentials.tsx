import type { AiGameConfiguration, ChessColor } from "@neurochess/contracts";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { CredentialSource, type SavedCredentialChoices } from "../arena/setup/credential-source";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { inputFieldClass } from "../ui/input-styles";
import { SecretInput } from "../ui/secret-input";

interface PausedCredentialsProps {
  readonly epoch: string;
  readonly paused: boolean;
  readonly seats: AiGameConfiguration["seats"];
  readonly keys: Readonly<Record<ChessColor, boolean>>;
  readonly rejectedColor: ChessColor | null;
  readonly disabled: boolean;
  readonly canContinue: boolean;
  readonly onKeyChange: (color: ChessColor, value: string) => void;
  readonly onResume: () => void;
  readonly children?: ReactNode;
  readonly notice?: ReactNode;
  readonly savedCredentials?: SavedCredentialChoices;
  readonly selections?: Readonly<Record<ChessColor, string>>;
  readonly onCredentialChange?: (color: ChessColor, value: string) => void;
}

interface Recovery {
  readonly epoch: string;
  readonly colors: readonly ChessColor[];
  readonly missing: boolean;
  readonly dismissed: boolean;
}

export function PausedCredentials(props: PausedCredentialsProps) {
  const { t } = useTranslation();
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const current = props.paused && recovery?.epoch === props.epoch ? recovery : null;
  const needed = (["white", "black"] as const).filter(
    (color) =>
      props.seats[color].type === "ai" && (!props.keys[color] || props.rejectedColor === color),
  );

  // Latch the recovery fields for this paused revision: typing must not remove a now-ready field.
  if (props.paused && !current && needed.length > 0) {
    setRecovery({
      epoch: props.epoch,
      colors: needed,
      missing: needed.some((color) => !props.keys[color]),
      dismissed: true,
    });
  } else if (!props.paused && recovery) {
    setRecovery(null);
  }

  return (
    <>
      {current ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-3 border-l-2 border-warning bg-surface p-3 text-label">
            <p className="min-w-0 grow basis-60">
              {t(
                props.rejectedColor
                  ? props.savedCredentials
                    ? "credentials.unavailable"
                    : "match.keyRejected"
                  : needed.some((color) => !props.keys[color])
                    ? "match.keysRequired"
                    : "match.returnPaused",
              )}
            </p>
            <Button
              variant="secondary"
              aria-haspopup="dialog"
              onClick={(event) => {
                // WebKit pointer activation does not focus buttons; Dialog restores the active element.
                event.currentTarget.focus({ preventScroll: true });
                setRecovery({ ...current, dismissed: false });
              }}
            >
              {t("match.restoreKeys")}
            </Button>
          </div>
          <RecoveryForm
            key={current.epoch}
            {...props}
            recovery={current}
            onDismiss={() => setRecovery({ ...current, dismissed: true })}
          />
        </>
      ) : null}
      {props.children}
    </>
  );
}

function RecoveryForm({
  seats,
  keys,
  rejectedColor,
  disabled,
  canContinue,
  onKeyChange,
  onResume,
  recovery,
  onDismiss,
  notice,
  savedCredentials,
  selections,
  onCredentialChange,
}: PausedCredentialsProps & {
  readonly recovery: Recovery;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [edited, setEdited] = useState({ white: false, black: false });
  const [maskEpoch, setMaskEpoch] = useState(0);
  const rejected = rejectedColor !== null && !edited[rejectedColor];
  const usesSessionKey = (color: ChessColor) =>
    !selections?.[color] || selections[color] === "session";
  function dismiss() {
    setMaskEpoch((epoch) => epoch + 1);
    onDismiss();
  }
  return (
    <Dialog
      open={!recovery.dismissed}
      title={t(savedCredentials ? "credentials.recoveryTitle" : "match.reenterKeys")}
      description={t(
        savedCredentials
          ? rejectedColor
            ? "credentials.unavailable"
            : "credentials.recovery"
          : rejectedColor || !recovery.missing
            ? "match.rejectedKeyDescription"
            : "match.recoveryDescription",
      )}
      closeLabel={t("match.closeRecovery")}
      onCancel={dismiss}
    >
      <div className="mt-6 grid min-w-0 gap-6">
        {notice ? <p className="text-label text-warning">{notice}</p> : null}
        {recovery.colors.map((color) => {
          const seat = seats[color];
          if (seat.type !== "ai") return null;
          const invalid = rejectedColor === color && !edited[color];
          return (
            <div key={color} className="grid min-w-0 gap-2 text-label">
              {savedCredentials ? (
                <CredentialSource
                  provider={seat.provider}
                  value={selections?.[color] ?? "session"}
                  saved={savedCredentials}
                  disabled={disabled}
                  label={`${t(`players.${color}`)} · ${t(`setup.providers.${seat.provider}`)} · ${t("credentials.source")}`}
                  onChange={(value) => {
                    setEdited((current) => ({ ...current, [color]: true }));
                    onCredentialChange?.(color, value);
                  }}
                />
              ) : null}
              {usesSessionKey(color) ? (
                <>
                  <label htmlFor={`${id}-${color}-key`}>
                    {t(`players.${color}`)} · {t(`setup.providers.${seat.provider}`)} ·{" "}
                    {t("setup.apiKey")}
                  </label>
                  <SecretInput
                    id={`${id}-${color}-key`}
                    aria-describedby={`${id}-session${invalid ? ` ${id}-${color}-error` : ""}`}
                    aria-invalid={invalid}
                    layout="icon"
                    maskEpoch={maskEpoch}
                    showLabel={t("match.showSeatKey", { color: t(`players.${color}`) })}
                    hideLabel={t("match.hideSeatKey", { color: t(`players.${color}`) })}
                    placeholder={t("match.keyPlaceholder")}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={4096}
                    className={`${inputFieldClass} w-full pr-12`}
                    readOnly={disabled}
                    aria-disabled={disabled}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setEdited((current) => ({ ...current, [color]: true }));
                      onKeyChange(color, value);
                    }}
                  />
                </>
              ) : null}
              {invalid ? (
                <p id={`${id}-${color}-error`} className="text-danger">
                  {t(savedCredentials ? "credentials.unavailable" : "match.keyRejected")}
                </p>
              ) : null}
            </div>
          );
        })}
        {recovery.colors.some(usesSessionKey) ? (
          <div id={`${id}-session`} className="grid gap-1 text-label text-text-secondary">
            <p className="font-semibold">{t("setup.sessionOnly")}</p>
            <p>{t("setup.sessionOnlyHint")}</p>
          </div>
        ) : null}
        <div className="grid gap-2">
          <Button
            variant="primary"
            className="flex-wrap"
            aria-label={t("match.resumeGame")}
            aria-disabled={
              disabled || !canContinue || rejected || recovery.colors.some((color) => !keys[color])
            }
            onClick={onResume}
          >
            <Icon path="m8 5 10 7-10 7z" />
            {t("lifecycle.resume")}
          </Button>
          <Button variant="quiet" onClick={dismiss}>
            {t("match.keepPaused")}
          </Button>
          <p className="text-center text-label text-text-muted">{t("match.returnPaused")}</p>
        </div>
      </div>
    </Dialog>
  );
}
