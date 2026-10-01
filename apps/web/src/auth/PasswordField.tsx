import { type ComponentProps, useEffect, useId, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { StableText } from "../ui/StableText";

import { AccountField } from "./AccountField";

export function PasswordField({
  showLabel,
  hideLabel,
  ...props
}: Omit<ComponentProps<typeof AccountField>, "type"> & {
  readonly showLabel: string;
  readonly hideLabel: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const [hasValue, setHasValue] = useState(false);
  useEffect(() => {
    const form = input.current?.form;
    const reset = () => {
      setHasValue(false);
      setRevealed(false);
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);
  return (
    <div className="grid gap-2">
      <AccountField
        {...props}
        id={id}
        ref={input}
        type={revealed ? "text" : "password"}
        onInput={(event) => {
          const present = event.currentTarget.value.length > 0;
          setHasValue(present);
          if (!present) setRevealed(false);
          props.onInput?.(event);
        }}
        onFocus={(event) => {
          setHasValue(event.currentTarget.value.length > 0);
          props.onFocus?.(event);
        }}
      />
      <Button
        variant="secondary"
        className="justify-self-start"
        aria-pressed={revealed}
        aria-controls={id}
        aria-disabled={props.readOnly === true || !hasValue}
        onClick={() => setRevealed((value) => !value)}
      >
        <StableText
          value={revealed ? hideLabel : showLabel}
          variants={[showLabel, hideLabel]}
          align="center"
        />
      </Button>
    </div>
  );
}
