import type { ComponentProps } from "react";

import { SecretInput } from "../ui/SecretInput";

import { AccountField } from "./AccountField";

export function PasswordField({
  showLabel,
  hideLabel,
  label,
  hint,
  error,
  ...props
}: Omit<ComponentProps<typeof AccountField>, "type" | "value" | "defaultValue" | "ref"> & {
  readonly showLabel: string;
  readonly hideLabel: string;
}) {
  return (
    <SecretInput
      {...props}
      showLabel={showLabel}
      hideLabel={hideLabel}
      layout="stacked"
      renderInput={(inputProps) => (
        <AccountField
          {...inputProps}
          label={label}
          {...(hint !== undefined ? { hint } : {})}
          {...(error !== undefined ? { error } : {})}
        />
      )}
    />
  );
}
