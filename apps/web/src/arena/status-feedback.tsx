import { cx } from "../ui/cx";

import type { StatusPresentation } from "./status";

// Reserve localized feedback variants without fixing heights or duplicating controls.
const feedbackSlotClassName = "min-w-0 self-start [grid-area:1/1] aria-hidden:invisible";
const noticeClassName = "border-l-2 border-warning pl-3 text-text";

export function StatusFeedback({
  feedback,
  notice,
  followUp,
}: Pick<StatusPresentation, "feedback" | "notice" | "followUp">) {
  const busy = feedback !== null && feedback.activeId !== null;
  return (
    <>
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
    </>
  );
}
