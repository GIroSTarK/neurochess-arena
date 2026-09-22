import { screen, within } from "@testing-library/react";

export function square(coordinate: string): HTMLElement {
  return within(screen.getByRole("grid")).getByRole("button", {
    name: new RegExp("^" + coordinate + ":"),
  });
}

// Use only within one mounted board's lifetime. Cache nodes, never their changing
// labels/selection/focus; accessibility assertions still read the live elements.
export function squaresOnBoard(grid = screen.getByRole("grid")) {
  const squares = new Map(
    within(grid)
      .getAllByRole<HTMLButtonElement>("button")
      .map((button) => [button.dataset.square, button]),
  );
  return (coordinate: string): HTMLButtonElement => {
    const button = squares.get(coordinate);
    if (!button || !grid.isConnected || !grid.contains(button)) {
      throw new Error(`Square ${coordinate} is absent or its board was replaced; query it again.`);
    }
    return button;
  };
}
