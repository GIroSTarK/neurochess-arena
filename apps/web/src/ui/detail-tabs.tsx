import { Activity, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";

import { cx } from "./cx";

export interface DetailTab {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
  readonly scroll?: "panel" | "content";
}

export function DetailTabs({
  label,
  tabs,
  initialTab,
}: {
  readonly label: string;
  readonly tabs: readonly [DetailTab, ...DetailTab[]];
  readonly initialTab?: string | undefined;
}) {
  const prefix = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const removedFocus = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState(initialTab ?? tabs[0].id);
  const [focused, setFocused] = useState(initialTab ?? tabs[0].id);
  const selectedId = tabs.some((tab) => tab.id === selected) ? selected : tabs[0].id;
  const focusedId = tabs.some((tab) => tab.id === focused) ? focused : selectedId;

  // Ref cleanup sees focus before removal; after the commit it may already be on the body.
  function rememberFocus(element: HTMLElement): void {
    if (element.contains(element.ownerDocument.activeElement)) removedFocus.current = element;
  }

  useLayoutEffect(() => {
    const removed = removedFocus.current;
    removedFocus.current = null;
    if (
      removed &&
      !removed.isConnected &&
      removed.ownerDocument.activeElement === removed.ownerDocument.body
    ) {
      buttons.current.get(focusedId)?.focus();
    }
  });

  return (
    <div className="flex min-h-min min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 border-b border-divider" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              if (!element) return;
              buttons.current.set(tab.id, element);
              return () => {
                rememberFocus(element);
                buttons.current.delete(tab.id);
              };
            }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${tab.id}`}
            aria-controls={`${prefix}-panel-${tab.id}`}
            aria-selected={tab.id === selectedId}
            tabIndex={tab.id === focusedId ? 0 : -1}
            className="min-h-target min-w-0 flex-1 border-b-2 border-transparent px-3 py-2 text-label wrap-anywhere text-text-secondary hover:bg-surface-raised aria-selected:border-accent aria-selected:font-semibold aria-selected:text-text"
            onFocus={() => setFocused(tab.id)}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const next = tabs[nextIndex];
              if (next) buttons.current.get(next.id)?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          ref={(element) => {
            if (element) return () => rememberFocus(element);
          }}
          id={`${prefix}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${prefix}-tab-${tab.id}`}
          hidden={tab.id !== selectedId}
          tabIndex={0}
          className={cx(
            "min-h-48 min-w-0 flex-1 flex-col focus-visible:-outline-offset-2 max-lg:max-h-[32rem] lg:min-h-32 lg:contain-size",
            tab.scroll !== "content" &&
              "[scrollbar-color:var(--color-control-border)_var(--color-surface)] [scrollbar-gutter:stable] overflow-y-auto px-2 pt-4 pb-2",
            tab.id === selectedId ? "flex" : "hidden",
          )}
        >
          <Activity mode={tab.id === selectedId ? "visible" : "hidden"}>{tab.content}</Activity>
        </div>
      ))}
    </div>
  );
}
