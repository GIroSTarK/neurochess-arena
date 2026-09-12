import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";

export function StartButton({
  label,
  disabled,
  onStart,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onStart: () => void;
}) {
  return (
    <Button variant="primary" className="mt-8" aria-disabled={disabled} onClick={onStart}>
      {label}
      <Icon path="M5 12h14m-6-6 6 6-6 6" />
    </Button>
  );
}
