import type { ModelDescriptor } from "@neurochess/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../../ui/cx";

export const setupFieldClass =
  "min-h-target w-full min-w-0 rounded-control border border-control-border bg-surface px-3 py-2 text-body text-text aria-invalid:border-danger";

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
  const list = useRef<HTMLUListElement>(null);
  const selected = models.find((model) => model.id === modelId);
  const matches = models.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const expanded = open && !unavailable;
  useEffect(() => {
    if (expanded) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, expanded]);

  function select(model: ModelDescriptor) {
    onSelect(model.id);
    setOpen(false);
  }

  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor={id} className="text-label">
        {t("setup.model")}
      </label>
      <input
        id={id}
        className={setupFieldClass}
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
      <p id={`${id}-hint`} className="text-label text-text-secondary">
        {t(unavailable ? "setup.loadBeforeModel" : "setup.searchModels")}
      </p>
      <ul
        id={`${id}-options`}
        ref={list}
        role="listbox"
        aria-label={t("setup.model")}
        hidden={!expanded}
        className="max-h-64 overflow-y-auto rounded-control border border-control-border bg-surface-raised p-1"
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
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(model)}
              >
                <span className="block">{model.name}</span>
                <span className="block font-mono text-label text-text-secondary">{model.id}</span>
                <span className="block text-label text-text-muted">
                  {t(`setup.capability.${model.capabilities.moveGeneration}`)}
                </span>
              </li>
            ))
          : null}
      </ul>
      {expanded && matches.length === 0 ? (
        <p className="text-label text-text-secondary">{t("setup.noMatches")}</p>
      ) : null}
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
