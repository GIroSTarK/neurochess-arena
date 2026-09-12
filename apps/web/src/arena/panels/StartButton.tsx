import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";

export function StartButton({
  label,
  disabled,
  onStart,
  variant = "primary",
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly variant?: "primary" | "secondary";
}) {
  return (
    <Button variant={variant} className="w-full" aria-disabled={disabled} onClick={onStart}>
      {label}
      <Icon path="M5 12h14m-6-6 6 6-6 6" />
    </Button>
  );
}
