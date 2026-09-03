/** Joins class names and skips falsy entries. Prettier sorts the utilities inside these calls. */
export function cx(...classes: readonly (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
