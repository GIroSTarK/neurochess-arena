import { type ComponentProps, useId } from "react";

export function AccountField({
  label,
  hint,
  error,
  ...props
}: ComponentProps<"input"> & {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
}) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor={id} className="text-label font-semibold">
        {label}
      </label>
      <input
        {...props}
        id={id}
        className="min-h-target w-full min-w-0 rounded-control border border-control-border bg-canvas px-3 py-2 text-body text-text"
        aria-invalid={Boolean(error)}
        aria-describedby={hint || error ? id + "-hint" : undefined}
      />
      {hint || error ? (
        <p id={id + "-hint"} className="text-label text-text-secondary">
          {error ? <span role="alert">{error}</span> : hint}
        </p>
      ) : null}
    </div>
  );
}
