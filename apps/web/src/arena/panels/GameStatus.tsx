import type { GameState } from "@neurochess/contracts";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../../ui/cx";
import { StableText } from "../../ui/StableText";
import type { StatusPresentation } from "../status";
import { StatusFeedback } from "../StatusFeedback";

export interface GameStatusProps extends StatusPresentation {
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
      <StatusFeedback feedback={feedback} notice={notice} followUp={followUp} />
      {children}
    </section>
  );
}
