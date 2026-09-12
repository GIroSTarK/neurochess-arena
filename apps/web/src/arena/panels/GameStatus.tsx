import type { GameState } from "@neurochess/contracts";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../../ui/cx";
import { StableText } from "../../ui/StableText";

interface FeedbackLabel {
  readonly id: string;
  readonly label: string;
}

export interface GameStatusProps {
  readonly title: string;
  readonly titleVariants: readonly string[];
  readonly lifecycle: {
    readonly state: GameState;
    readonly label: string;
    readonly variants: readonly string[];
  } | null;
  readonly result: { readonly reason: string; readonly score: string } | null;
  readonly description: string | null;
  readonly feedback: {
    readonly activeId: string | null;
    readonly activities: readonly FeedbackLabel[];
    readonly notices: readonly (FeedbackLabel & { readonly visible: boolean })[];
  } | null;
  readonly notice: string | null;
  readonly followUp: string | null;
  readonly children?: ReactNode;
}

// Labels and shapes keep lifecycle distinguishable without color.
const lifecycleMarks: Record<GameState, string> = {
  configuring: "before:rounded-full before:bg-current",
  active: "before:rounded-full before:bg-accent",
  paused: "before:rounded-none before:bg-warning",
  completed: "before:rounded-full before:bg-success",
  aborted: "before:rounded-full before:bg-current",
};

// Reserve localized feedback variants without duplicating controls or imposing a fixed height.
const feedbackSlotClassName = "min-w-0 self-start [grid-area:1/1] aria-hidden:invisible";
const noticeClassName = "border-l-2 border-warning pl-3 text-text";

export function GameStatus({
  title,
  titleVariants,
  lifecycle,
  result,
  description,
  feedback,
  notice,
  followUp,
  children,
}: GameStatusProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const busy = feedback !== null && feedback.activeId !== null;
  return (
    <section className="rounded-panel bg-surface px-6 py-4 max-sm:px-4" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-label text-text-secondary">{t("game.status")}</p>
        {lifecycle ? (
          <span
            className={cx(
              "inline-flex items-center gap-2 text-right text-label text-text-muted before:size-[0.4rem] before:shrink-0 before:content-['']",
              lifecycleMarks[lifecycle.state],
            )}
          >
            <StableText value={lifecycle.label} variants={lifecycle.variants} />
          </span>
        ) : null}
      </div>
      <h2 id={headingId} className="mt-3 text-title font-semibold max-sm:text-[1.5rem]/8">
        <StableText value={title} variants={titleVariants} />
      </h2>
      {result ? (
        <p className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-text-secondary">
          {result.reason} <span className="font-mono text-text">{result.score}</span>
        </p>
      ) : null}
      {description ? <p className="mt-3 text-text-secondary">{description}</p> : null}
      {feedback ? (
        <div
          className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] text-text-secondary"
          data-testid="status-feedback"
        >
          <div
            className={cx(
              feedbackSlotClassName,
              "group grid grid-cols-[0.5rem_1fr] gap-2 text-accent",
            )}
            data-testid="activity-feedback"
            aria-busy={busy}
            aria-hidden={!busy}
          >
            <span
              className="mt-[0.2rem] h-4 w-[0.4rem] bg-current motion-safe:group-aria-busy:animate-activity-pulse"
              aria-hidden="true"
            />
            <div className="grid">
              {feedback.activities.map(({ id, label }) => (
                <p
                  key={id}
                  className="[grid-area:1/1] aria-hidden:invisible"
                  aria-hidden={feedback.activeId !== id}
                >
                  {label}
                </p>
              ))}
            </div>
          </div>
          {feedback.notices.map(({ id, label, visible }) => (
            <p
              key={id}
              className={cx(feedbackSlotClassName, noticeClassName)}
              aria-hidden={busy || !visible}
            >
              {label}
            </p>
          ))}
        </div>
      ) : null}
      {notice ? <p className={cx("my-4", noticeClassName)}>{notice}</p> : null}
      {followUp ? <p className="mt-3 text-text-secondary">{followUp}</p> : null}
      {children}
    </section>
  );
}
