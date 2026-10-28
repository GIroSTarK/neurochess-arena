import { Activity, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";

import { cx } from "./cx";

export interface DetailTab {
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
  readonly scroll?: "panel" | "content";
}

export interface DetailTabsProps {
  readonly label: string;
  readonly tabs: readonly [DetailTab, ...DetailTab[]];
  readonly initialTab?: string | undefined;
  readonly selectedTab?: string | undefined;
  readonly onSelectTab?: (id: string) => void;
  readonly pinnedTabIds?: readonly string[];
}

export function DetailTabs({
  label,
  tabs,
  initialTab,
  selectedTab,
  onSelectTab,
  pinnedTabIds = [],
}: DetailTabsProps) {
  const prefix = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const removedFocus = useRef<HTMLElement | null>(null);
  const panelFocus = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState(initialTab ?? tabs[0].id);
  const [focused, setFocused] = useState(selectedTab ?? initialTab ?? tabs[0].id);
  const selectable = tabs.filter((tab) => !pinnedTabIds.includes(tab.id));
  const selection = selectedTab ?? selected;
  const selectedId = selectable.some((tab) => tab.id === selection) ? selection : selectable[0]?.id;
  const focusedId = selectable.some((tab) => tab.id === focused) ? focused : selectedId;

  // Ref cleanup sees focus before removal; after the commit it may already be on the body.
  function rememberFocus(element: HTMLElement): void {
    const active = element.ownerDocument.activeElement;
    if (active instanceof HTMLElement && element.contains(active)) removedFocus.current = active;
  }

  useLayoutEffect(() => {
    const removed = removedFocus.current ?? panelFocus.current;
    removedFocus.current = null;
    if (
      removed &&
      ((!removed.isConnected &&
        removed.ownerDocument.activeElement === removed.ownerDocument.body) ||
        (removed.closest("[hidden]") &&
          (removed.contains(removed.ownerDocument.activeElement) ||
            removed.ownerDocument.activeElement === removed.ownerDocument.body)))
    ) {
      const target = removed.isConnected ? selectedId : focusedId;
      if (target) buttons.current.get(target)?.focus({ preventScroll: true });
    } else if (
      removed?.isConnected &&
      removed.ownerDocument.activeElement === removed.ownerDocument.body
    ) {
      removed.focus({ preventScroll: true });
    }
  });

  const tablist =
    selectable.length > 0 ? (
      <div
        key="tablist"
        className="flex shrink-0 flex-wrap border-b border-divider"
        role="tablist"
        aria-label={label}
      >
        {selectable.map((tab, index) => (
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
            className="min-h-target min-w-0 flex-auto border-b-2 border-transparent px-3 py-2 text-label wrap-anywhere text-text-secondary hover:bg-surface-raised aria-selected:border-accent aria-selected:font-semibold aria-selected:text-text"
            onFocus={() => setFocused(tab.id)}
            onClick={() => {
              if (selectedTab === undefined) setSelected(tab.id);
              onSelectTab?.(tab.id);
            }}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === "ArrowRight"
                  ? (index + 1) % selectable.length
                  : event.key === "ArrowLeft"
                    ? (index + selectable.length - 1) % selectable.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? selectable.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const next = selectable[nextIndex];
              if (next) buttons.current.get(next.id)?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    ) : null;
  const panels = tabs.map((tab) => {
    const pinned = pinnedTabIds.includes(tab.id);
    const visible = pinned || tab.id === selectedId;
    return {
      pinned,
      element: (
        <div
          key={`panel-${tab.id}`}
          ref={(element) => {
            if (element) return () => rememberFocus(element);
          }}
          id={`${prefix}-panel-${tab.id}`}
          role={pinned ? "region" : "tabpanel"}
          aria-label={pinned ? tab.label : undefined}
          aria-labelledby={pinned ? undefined : `${prefix}-tab-${tab.id}`}
          hidden={!visible}
          tabIndex={pinned ? undefined : 0}
          className={cx(
            "min-w-0 flex-col focus-visible:-outline-offset-2",
            pinned
              ? "mb-4 shrink-0"
              : "min-h-80 flex-1 @max-arena-wide/arena:max-h-[32rem] @arena-wide/arena:contain-size",
            !pinned &&
              tab.scroll !== "content" &&
              "[scrollbar-color:var(--color-control-border)_var(--color-surface)] [scrollbar-gutter:stable] overflow-y-auto px-2 pt-4 pb-2",
            visible ? "flex" : "hidden",
          )}
        >
          {tab.scroll === "content" ? (
            <Activity mode={visible ? "visible" : "hidden"}>{tab.content}</Activity>
          ) : (
            tab.content
          )}
        </div>
      ),
    };
  });

  // Commentary keeps its effects and portaled dialogs; content scrollers measure only when visible.
  return (
    <div
      className="flex min-h-min min-w-0 flex-1 flex-col"
      onFocusCapture={(event) => {
        panelFocus.current = event.currentTarget.contains(event.target) ? event.target : null;
      }}
      onBlurCapture={() => {
        panelFocus.current = null;
      }}
    >
      {[
        ...panels.filter((panel) => panel.pinned).map((panel) => panel.element),
        tablist,
        ...panels.filter((panel) => !panel.pinned).map((panel) => panel.element),
      ]}
    </div>
  );
}
