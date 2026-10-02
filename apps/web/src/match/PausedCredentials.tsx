import type { AiGameConfiguration, ChessColor } from "@neurochess/contracts";
import {
  Activity,
  type ReactNode,
  type Ref,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { CredentialSource, type SavedCredentialChoices } from "../arena/setup/CredentialSource";
import { setupFieldClass } from "../arena/setup/ModelPicker";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/Icon";

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
  readonly children: ReactNode;
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
  const heading = useRef<HTMLHeadingElement>(null);
  const reopen = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<"form" | "banner" | null>(null);
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
      dismissed: false,
    });
  } else if (!props.paused && recovery) {
    setRecovery(null);
  }

  useLayoutEffect(() => {
    if (focusTarget.current === "form") heading.current?.focus();
    if (focusTarget.current === "banner") reopen.current?.focus();
    focusTarget.current = null;
  }, [current?.dismissed]);

  return (
    <>
      {current ? (
        <>
          <Activity mode={current.dismissed ? "hidden" : "visible"}>
            <RecoveryForm
              key={current.epoch}
              {...props}
              recovery={current}
              headingRef={heading}
              onDismiss={() => {
                focusTarget.current = "banner";
                setRecovery({ ...current, dismissed: true });
              }}
            />
          </Activity>
          {current.dismissed ? (
            <div className="grid shrink-0 gap-2 border-l-2 border-warning bg-surface p-3 text-label">
              <p>
                {t(
                  needed.some((color) => !props.keys[color])
                    ? "match.keysRequired"
                    : "match.returnPaused",
                )}
              </p>
              <Button
                ref={reopen}
                variant="secondary"
                onClick={() => {
                  focusTarget.current = "form";
                  setRecovery({ ...current, dismissed: false });
                }}
              >
                {t(props.savedCredentials ? "credentials.recoveryTitle" : "match.reenterKeys")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <Activity mode={current && !current.dismissed ? "hidden" : "visible"}>
        {props.children}
      </Activity>
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
  headingRef,
  onDismiss,
  notice,
  savedCredentials,
  selections,
  onCredentialChange,
}: PausedCredentialsProps & {
  readonly recovery: Recovery;
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [edited, setEdited] = useState({ white: false, black: false });
  const [hasValue, setHasValue] = useState({ white: false, black: false });
  const [revealed, setRevealed] = useState({ white: false, black: false });
  const [dismissedTooltip, setDismissedTooltip] = useState<ChessColor | null>(null);
  const rejected = rejectedColor !== null && !edited[rejectedColor];
  const usesSessionKey = (color: ChessColor) =>
    !selections?.[color] || selections[color] === "session";
  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className="grid min-w-0 shrink-0 gap-6 rounded-panel border border-control-border bg-surface-raised p-4 sm:p-6"
    >
      <span className="flex size-target items-center justify-center rounded-control border border-control-border text-warning">
        <Icon path="M6 10h12v11H6zM9 10V6a3 3 0 0 1 6 0v4M12 14v3" />
      </span>
      <div className="grid gap-3">
        <h2
          ref={headingRef}
          id={`${id}-title`}
          tabIndex={-1}
          className="text-section font-semibold"
        >
          {t(savedCredentials ? "credentials.recoveryTitle" : "match.reenterKeys")}
        </h2>
        <p id={`${id}-description`} className="text-body text-text-secondary">
          {t(
            savedCredentials
              ? recovery.missing
                ? "credentials.recovery"
                : "credentials.unavailable"
              : recovery.missing
                ? "match.recoveryDescription"
                : "match.rejectedKeyDescription",
          )}
        </p>
        {notice ? <p className="text-label text-warning">{notice}</p> : null}
      </div>
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
                  setHasValue((current) => ({ ...current, [color]: false }));
                  setRevealed((current) => ({ ...current, [color]: false }));
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
                <div className="relative min-w-0">
                  <input
                    id={`${id}-${color}-key`}
                    aria-describedby={`${id}-session${invalid ? ` ${id}-${color}-error` : ""}`}
                    aria-invalid={invalid}
                    type={revealed[color] ? "text" : "password"}
                    placeholder={t("match.keyPlaceholder")}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={4096}
                    className={`${setupFieldClass} w-full pr-12`}
                    readOnly={disabled}
                    aria-disabled={disabled}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setEdited((current) => ({ ...current, [color]: true }));
                      setHasValue((current) => ({ ...current, [color]: value.length > 0 }));
                      if (!value) setRevealed((current) => ({ ...current, [color]: false }));
                      onKeyChange(color, value);
                    }}
                  />
                  <span
                    className="group absolute top-0 right-0"
                    onPointerEnter={() => setDismissedTooltip(null)}
                  >
                    <Button
                      variant="quiet"
                      padding="compact"
                      className="size-target focus-visible:-outline-offset-2"
                      aria-labelledby={`${id}-${color}-reveal`}
                      aria-controls={`${id}-${color}-key`}
                      aria-pressed={revealed[color]}
                      aria-disabled={disabled || !hasValue[color]}
                      onClick={() =>
                        setRevealed((current) => ({ ...current, [color]: !current[color] }))
                      }
                      onFocus={() => setDismissedTooltip(null)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setDismissedTooltip(color);
                      }}
                    >
                      <Icon
                        path={
                          revealed[color]
                            ? "M3 3l18 18M10 5a10 10 0 0 1 11 7 14 14 0 0 1-3 4M6 6a14 14 0 0 0-3 6c4 8 12 8 16 3M10 10a3 3 0 0 0 4 4"
                            : "M2 12c5-9 15-9 20 0-5 9-15 9-20 0M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0"
                        }
                      />
                    </Button>
                    <span
                      id={`${id}-${color}-reveal`}
                      role="tooltip"
                      className={cx(
                        "absolute right-0 bottom-full z-10 hidden w-max max-w-40 pb-2 text-label text-text",
                        dismissedTooltip !== color && "group-focus-within:block group-hover:block",
                      )}
                    >
                      <span className="block rounded-control border border-control-border bg-surface-raised px-3 py-2">
                        {t(revealed[color] ? "match.hideSeatKey" : "match.showSeatKey", {
                          color: t(`players.${color}`),
                        })}
                      </span>
                    </span>
                  </span>
                </div>
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
          aria-label={t("match.resumeGame")}
          aria-disabled={
            disabled || !canContinue || rejected || recovery.colors.some((color) => !keys[color])
          }
          onClick={onResume}
        >
          <Icon path="m8 5 10 7-10 7z" />
          {t("lifecycle.resume")}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setRevealed({ white: false, black: false });
            onDismiss();
          }}
        >
          {t("setup.returnToGame")}
          <Icon path="M5 12h14m-5-5 5 5-5 5" />
        </Button>
        <p className="text-center text-label text-text-muted">{t("match.returnPaused")}</p>
      </div>
    </section>
  );
}
