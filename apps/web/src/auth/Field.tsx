import { type ComponentProps, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";

export function Field({
  label,
  hint,
  error,
  secret = false,
  ...props
}: ComponentProps<"input"> & {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly secret?: boolean;
}) {
  const id = useId();
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  if (!props.value && shown) setShown(false);
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor={id} className="text-label font-semibold">
        {label}
      </label>
      <div className="flex min-w-0 flex-wrap justify-end gap-2">
        <input
          {...props}
          id={id}
          type={secret ? (shown && props.value ? "text" : "password") : props.type}
          aria-invalid={Boolean(error)}
          aria-describedby={hint || error ? id + "-help" : undefined}
          className="min-h-target w-full min-w-0 flex-1 basis-48 rounded-control border border-control-border bg-canvas px-3 py-2 text-body text-text aria-invalid:border-danger"
        />
        {secret ? (
          <Button
            className="shrink-0"
            variant="secondary"
            aria-disabled={!props.value}
            onClick={() => setShown(!shown)}
          >
            {t(shown && props.value ? "auth.hidePassword" : "auth.showPassword")}
          </Button>
        ) : null}
      </div>
      {hint || error ? (
        <p
          id={id + "-help"}
          className={error ? "text-label text-danger" : "text-label text-text-secondary"}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
