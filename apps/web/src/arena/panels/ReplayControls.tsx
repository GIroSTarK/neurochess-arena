import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { Icon } from "../../ui/Icon";

export function ReplayControls({
  available,
  loading,
  count,
  ply,
  notice,
  onSelect,
  onRetry,
}: {
  readonly available: boolean;
  readonly loading: boolean;
  readonly count: number;
  readonly ply: number;
  readonly notice: string | null;
  readonly onSelect: (ply: number) => void;
  readonly onRetry: (() => void) | null;
}) {
  const { t } = useTranslation();
  const tooltipId = useId();
  const [dismissedTooltip, setDismissedTooltip] = useState<string | null>(null);
  return (
    <section className="mt-4 min-w-0" aria-label={t("replay.title")}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-wrap gap-2">
          {(
            [
              { key: "first", target: 0, disabled: ply === 0, path: "M6 5v14M18 5l-9 7 9 7z" },
              { key: "previous", target: ply - 1, disabled: ply === 0, path: "m15 5-7 7 7 7" },
              { key: "next", target: ply + 1, disabled: ply === count, path: "m9 5 7 7-7 7" },
              {
                key: "last",
                target: count,
                disabled: ply === count,
                path: "M18 5v14M6 5l9 7-9 7z",
              },
            ] as const
          ).map((control) => (
            <span
              key={control.key}
              className="group relative"
              onPointerEnter={() => setDismissedTooltip(null)}
            >
              <Button
                variant="secondary"
                padding="compact"
                className="size-target"
                aria-label={t(`replay.${control.key}`)}
                aria-describedby={`${tooltipId}-${control.key}`}
                aria-disabled={!available || control.disabled}
                onClick={() => onSelect(control.target)}
                onFocus={() => setDismissedTooltip(null)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setDismissedTooltip(control.key);
                }}
              >
                <Icon path={control.path} />
              </Button>
              <span
                id={`${tooltipId}-${control.key}`}
                role="tooltip"
                className={cx(
                  "absolute bottom-full left-0 z-10 hidden w-max max-w-40 pb-2 text-label text-text",
                  dismissedTooltip !== control.key && "group-focus-within:block group-hover:block",
                )}
              >
                <span className="block rounded-control border border-control-border bg-surface-raised px-3 py-2">
                  {t(`replay.${control.key}`)}
                </span>
              </span>
            </span>
          ))}
        </div>
        <span className="ml-auto text-right text-label text-text-secondary">
          {t("replay.position", { ply, count })}
        </span>
      </div>
      {loading ? <p className="mt-3 text-text-secondary">{t("replay.loading")}</p> : null}
      {notice ? <p className="mt-3 text-text-secondary">{notice}</p> : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {t("replay.retry")}
        </Button>
      ) : null}
    </section>
  );
}
