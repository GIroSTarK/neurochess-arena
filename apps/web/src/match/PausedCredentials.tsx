import type { AiGameConfiguration, ChessColor } from "@neurochess/contracts";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { setupFieldClass } from "../arena/setup/ModelPicker";
import { Button } from "../ui/Button";

export function PausedCredentials({
  seats,
  keys,
  rejectedColor,
  disabled,
  onKeyChange,
}: {
  readonly seats: AiGameConfiguration["seats"];
  readonly keys: Readonly<Record<ChessColor, boolean>>;
  readonly rejectedColor: ChessColor | null;
  readonly disabled: boolean;
  readonly onKeyChange: (color: ChessColor, value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [editing, setEditing] = useState({ white: false, black: false });
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const aiColors = (["white", "black"] as const).filter((color) => seats[color].type === "ai");
  const visibleColors = aiColors.filter(
    (color) => expanded === true || !keys[color] || rejectedColor === color || editing[color],
  );

  const isExpanded = expanded ?? visibleColors.length > 0;
  const missingKeys = aiColors.some((color) => !keys[color]);
  const rejectedKey = rejectedColor !== null && !editing[rejectedColor];

  return (
    <>
      <Button
        variant="quiet"
        aria-disabled={disabled}
        aria-expanded={isExpanded}
        aria-controls={id}
        onClick={() => {
          setExpanded(!isExpanded);
        }}
      >
        {t(isExpanded ? "match.hideKeys" : "match.changeKeys")}
      </Button>
      {!isExpanded && (missingKeys || rejectedKey) ? (
        <p className="text-label text-text-secondary">
          {t(missingKeys ? "match.keysRequired" : "match.keyRejected")}
        </p>
      ) : null}
      <section
        id={id}
        aria-label={t("match.keys")}
        hidden={!isExpanded}
        className={isExpanded ? "grid gap-4" : "hidden"}
      >
        {visibleColors.length > 0 ? (
          <p className="text-label text-text-secondary">
            {t("setup.sessionOnly")} · {t("setup.sessionOnlyHint")}
          </p>
        ) : null}
        {visibleColors.map((color) => {
          const seat = seats[color];
          if (seat.type !== "ai") return null;
          return (
            <div key={color} className="grid min-w-0 gap-2 text-label">
              <label htmlFor={`${id}-${color}-key`}>
                {t(`players.${color}`)} · {t(`setup.providers.${seat.provider}`)} ·{" "}
                {t("setup.apiKey")}
              </label>
              <input
                id={`${id}-${color}-key`}
                aria-describedby={`${id}-${color}-hint`}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={4096}
                className={setupFieldClass}
                readOnly={disabled}
                aria-disabled={disabled}
                onChange={(event) => {
                  setEditing((current) => ({ ...current, [color]: true }));
                  onKeyChange(color, event.target.value);
                }}
              />
              <span id={`${id}-${color}-hint`} className="text-text-secondary">
                {t(
                  rejectedColor === color && !editing[color]
                    ? "match.keyRejected"
                    : keys[color]
                      ? "match.keyReady"
                      : "match.keyMissing",
                )}
              </span>
            </div>
          );
        })}
      </section>
    </>
  );
}
