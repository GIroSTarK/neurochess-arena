import type { ModelDescriptor } from "@neurochess/contracts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../../ui/cx";
import { inputFieldClass } from "../../ui/input-styles";

export function ModelPicker({
  models,
  modelId,
  unavailable,
  onSelect,
}: {
  readonly models: readonly ModelDescriptor[];
  readonly modelId: string;
  readonly unavailable: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [popup, setPopup] = useState({ above: false, space: 256 });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const selected = models.find((model) => model.id === modelId);
  const matches = models.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const expanded = open && !unavailable;
  useLayoutEffect(() => {
    const field = input.current;
    if (!expanded || !field) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = field.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const clearance = rem / 2 + 8;
      const below = Math.max(0, bottom - rect.bottom - clearance);
      const above = Math.max(0, rect.top - top - clearance);
      const preferred = 16 * rem;
      const opensAbove = below < preferred && above > below;
      const space = opensAbove ? above : below;
      setPopup((previous) =>
        previous.above === opensAbove && previous.space === space
          ? previous
          : { above: opensAbove, space },
      );
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(field);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    const menu = list.current;
    const option = menu?.children[active];
    if (!expanded || !menu || !option) return;
    // scrollIntoView would also move the page when navigating an overlaid list.
    const menuRect = menu.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < menuRect.top || optionRect.height > menu.clientHeight) {
      menu.scrollTop += optionRect.top - menuRect.top;
    } else if (optionRect.bottom > menuRect.bottom) {
      menu.scrollTop += optionRect.bottom - menuRect.bottom;
    }
  }, [active, expanded, query, popup.space]);

  function select(model: ModelDescriptor) {
    onSelect(model.id);
    setOpen(false);
  }

  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor={id} className="text-label">
        {t("setup.model")}
      </label>
      <div className="relative min-w-0">
        <input
          ref={input}
          id={id}
          className={inputFieldClass}
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={`${id}-options`}
          aria-activedescendant={expanded && matches[active] ? `${id}-option-${active}` : undefined}
          aria-describedby={`${id}-hint${selected ? ` ${id}-selection` : ""}`}
          aria-disabled={unavailable}
          readOnly={unavailable}
          value={expanded ? query : (selected?.name ?? "")}
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setActive(0);
          }}
          onClick={() => {
            if (!expanded) {
              setOpen(true);
              setQuery("");
              setActive(0);
            }
          }}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (unavailable) return;
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!expanded) {
                setOpen(true);
                setQuery("");
                setActive(0);
              } else {
                setActive((index) =>
                  Math.max(
                    0,
                    Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                  ),
                );
              }
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const model = matches[active];
              if (expanded && model) select(model);
            }
          }}
        />
        <div
          hidden={!expanded}
          className={cx(
            "absolute inset-x-0 z-20 flex flex-col rounded-control border border-control-border bg-surface-raised shadow-[0_0.5rem_1.5rem_var(--color-canvas)]",
            popup.above ? "bottom-full mb-2" : "top-full mt-2",
          )}
          style={{ maxHeight: `min(16rem, ${popup.space}px)` }}
          // Preserve combobox focus for the native scrollbar as well as the options.
          onMouseDown={(event) => event.preventDefault()}
        >
          <ul
            id={`${id}-options`}
            ref={list}
            role="listbox"
            aria-label={t("setup.model")}
            className="min-h-0 overflow-y-auto p-1"
          >
            {expanded
              ? matches.map((model, index) => (
                  <li
                    id={`${id}-option-${index}`}
                    key={model.id}
                    role="option"
                    aria-selected={model.id === modelId}
                    className={cx(
                      "min-h-target cursor-pointer rounded-control p-3 text-body [overflow-wrap:anywhere]",
                      index === active && "bg-surface outline-2 -outline-offset-2 outline-focus",
                    )}
                    onClick={() => select(model)}
                  >
                    <span className="block">{model.name}</span>
                    <span className="block font-mono text-label text-text-secondary">
                      {model.id}
                    </span>
                    <span className="block text-label text-text-muted">
                      {t(`setup.capability.${model.capabilities.moveGeneration}`)}
                    </span>
                  </li>
                ))
              : null}
          </ul>
          {expanded && matches.length === 0 ? (
            <p className="overflow-y-auto p-3 text-label text-text-secondary">
              {t("setup.noMatches")}
            </p>
          ) : null}
        </div>
      </div>
      <p id={`${id}-hint`} className="text-label text-text-secondary">
        {t(unavailable ? "setup.loadBeforeModel" : "setup.searchModels")}
      </p>
      {selected ? (
        <div id={`${id}-selection`} className="text-label [overflow-wrap:anywhere]">
          <p>{selected.name}</p>
          <p className="font-mono text-text-secondary">{selected.id}</p>
          <p
            className={
              selected.capabilities.moveGeneration === "supported"
                ? "text-text-secondary"
                : "text-warning"
            }
          >
            {t(`setup.capability.${selected.capabilities.moveGeneration}`)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
