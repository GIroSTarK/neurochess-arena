import { type ComponentProps, type ReactNode, useCallback, useId, useState } from "react";

import { Button } from "./Button";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { StableText } from "./StableText";

type InputProps = ComponentProps<"input">;

interface SecretInputProps extends Omit<InputProps, "type" | "value" | "defaultValue" | "ref"> {
  readonly showLabel: string;
  readonly hideLabel: string;
  readonly layout?: "inline" | "stacked" | "icon";
  readonly maskEpoch?: number;
  readonly renderInput?: (props: InputProps) => ReactNode;
}

// The DOM owns the plaintext; shared state tracks only presence and visibility.
export function SecretInput({
  showLabel,
  hideLabel,
  layout = "inline",
  maskEpoch = 0,
  renderInput,
  onChange,
  onInput,
  onFocus,
  ...props
}: SecretInputProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const [visibility, setVisibility] = useState({ epoch: maskEpoch, revealed: false });
  const revealed = visibility.epoch === maskEpoch && visibility.revealed;
  const [hasValue, setHasValue] = useState(false);
  const [tooltipDismissed, setTooltipDismissed] = useState(false);

  const inputRef = useCallback((element: HTMLInputElement | null) => {
    const form = element?.form;
    const reset = () => {
      setHasValue(false);
      setVisibility((current) => ({ ...current, revealed: false }));
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  function observeValue(value: string) {
    setHasValue(value.length > 0);
    if (!value) setVisibility((current) => ({ ...current, revealed: false }));
  }

  const inputProps: InputProps = {
    ...props,
    id,
    ref: inputRef,
    type: revealed ? "text" : "password",
    onChange: (event) => {
      observeValue(event.currentTarget.value);
      onChange?.(event);
    },
    onInput: (event) => {
      observeValue(event.currentTarget.value);
      onInput?.(event);
    },
    onFocus: (event) => {
      observeValue(event.currentTarget.value);
      onFocus?.(event);
    },
  };
  const icon = layout === "icon";
  const toggle = (
    <Button
      variant={icon ? "quiet" : "secondary"}
      padding={icon ? "compact" : "normal"}
      className={cx(
        icon && "size-target focus-visible:-outline-offset-2",
        layout === "stacked" && "justify-self-start",
      )}
      aria-labelledby={icon ? `${id}-reveal` : undefined}
      aria-controls={id}
      aria-pressed={revealed}
      aria-disabled={
        props.disabled === true ||
        props.readOnly === true ||
        !hasValue ||
        props["aria-disabled"] === true ||
        props["aria-disabled"] === "true"
      }
      onClick={() =>
        setVisibility((current) => ({
          epoch: maskEpoch,
          revealed: current.epoch === maskEpoch ? !current.revealed : true,
        }))
      }
      onFocus={() => setTooltipDismissed(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setTooltipDismissed(true);
      }}
    >
      {icon ? (
        <Icon
          path={
            revealed
              ? "M3 3l18 18M10 5a10 10 0 0 1 11 7 14 14 0 0 1-3 4M6 6a14 14 0 0 0-3 6c4 8 12 8 16 3M10 10a3 3 0 0 0 4 4"
              : "M2 12c5-9 15-9 20 0-5 9-15 9-20 0M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0"
          }
        />
      ) : (
        <StableText
          value={revealed ? hideLabel : showLabel}
          variants={[showLabel, hideLabel]}
          align="center"
        />
      )}
    </Button>
  );

  return (
    <div
      className={
        icon
          ? "relative min-w-0"
          : layout === "stacked"
            ? "grid gap-2"
            : "flex min-w-0 flex-wrap gap-2"
      }
    >
      {renderInput ? renderInput(inputProps) : <input {...inputProps} />}
      {icon ? (
        <span
          className="group absolute top-0 right-0"
          onPointerEnter={() => setTooltipDismissed(false)}
        >
          {toggle}
          <span
            id={`${id}-reveal`}
            role="tooltip"
            className={cx(
              "absolute right-0 bottom-full z-10 hidden w-max max-w-40 pb-2 text-label text-text",
              !tooltipDismissed && "group-focus-within:block group-hover:block",
            )}
          >
            <span className="block rounded-control border border-control-border bg-surface-raised px-3 py-2">
              {revealed ? hideLabel : showLabel}
            </span>
          </span>
        </span>
      ) : (
        toggle
      )}
    </div>
  );
}
