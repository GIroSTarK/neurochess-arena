import { screen, within } from "@testing-library/react";

/** The rendered chessboard square whose accessible name starts with its coordinate. */
export function square(coordinate: string): HTMLElement {
  return within(screen.getByRole("grid")).getByRole("button", {
    name: new RegExp("^" + coordinate + ":"),
  });
}
