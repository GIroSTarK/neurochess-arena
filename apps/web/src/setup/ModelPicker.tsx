import type { ModelDescriptor } from "@neurochess/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../ui/cx";

export const fieldClass =
  "min-h-target w-full min-w-0 rounded-control border border-control-border bg-canvas px-3 py-2 text-body text-text";

export function ModelPicker({
  models,
  modelId,
  onSelect,
  disabled,
}: {
  readonly models: ModelDescriptor[];
  readonly modelId: string;
  readonly onSelect: (modelId: string) => void;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(
    () => models.find((model) => model.id === modelId)?.name ?? "",
  );
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const results = models.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const activeIndex = Math.min(active, results.length - 1);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [id, activeIndex, open, query]);
  function select(model: ModelDescriptor) {
    if (disabled) return;
    setQuery(model.name);
    setOpen(false);
    onSelect(model.id);
  }
  return (
    <div
      className="relative min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={id} className="mb-2 block text-label font-semibold">
        {t("setup.model")}
      </label>
      <input
        ref={input}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
        aria-describedby={`${id}-hint`}
        aria-disabled={disabled}
        readOnly={disabled}
        autoComplete="off"
        className={fieldClass}
        value={query}
        placeholder={t("setup.searchModels")}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onClick={() => {
          if (!disabled) setOpen(true);
        }}
        onChange={(event) => {
          if (disabled) return;
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
          onSelect("");
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActive(
              open
                ? Math.max(
                    0,
                    Math.min(
                      results.length - 1,
                      activeIndex + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  )
                : 0,
            );
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const model = results[activeIndex];
            if (model) select(model);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
      {open ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={t("setup.models")}
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-control border border-control-border bg-surface-raised p-1 shadow-lg"
        >
          {results.map((model, index) => (
            <li
              key={model.id}
              id={`${id}-${index}`}
              role="option"
              aria-selected={modelId === model.id}
              className={cx(
                "min-h-target cursor-pointer rounded-control p-3 text-label break-words",
                activeIndex === index && "bg-canvas text-accent",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                select(model);
                input.current?.focus();
              }}
            >
              <span className="block font-semibold">{model.name}</span>
              <span className="block text-caption text-text-secondary">{model.id}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p id={`${id}-hint`} className="mt-2 text-label text-text-secondary" role="status">
        {open && results.length === 0 ? t("setup.noMatches") : modelId || t("setup.chooseModel")}
      </p>
    </div>
  );
}
