import { screen, within } from "@testing-library/react";

export function square(coordinate: string): HTMLElement {
  return within(screen.getByRole("grid")).getByRole("button", {
    name: new RegExp("^" + coordinate + ":"),
  });
}
