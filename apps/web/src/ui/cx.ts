/** Prettier is configured to sort Tailwind utilities inside these calls. */
export function cx(...classes: readonly (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
