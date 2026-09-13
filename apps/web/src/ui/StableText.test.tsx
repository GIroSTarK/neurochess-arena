import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StableText } from "./StableText";

describe("stable text", () => {
  it("does not duplicate an accessible label when translations are identical", () => {
    render(
      <button type="button">
        <StableText value="Continue" variants={["Continue", "Continue"]} />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getAllByText("Continue")).toHaveLength(1);
  });
});
