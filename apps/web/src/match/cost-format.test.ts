import { describe, expect, it } from "vitest";

import { formatUsd } from "./cost-format";

describe("estimated USD display", () => {
  it.each([
    ["0.000000000000", "$0.00"],
    ["0.000000000001", "$0.000000000001"],
    ["0.300000000003", "$0.300000000003"],
    ["12.340000000000", "$12.34"],
    ["9007199254740993.123456789012", "$9,007,199,254,740,993.123456789012"],
  ])("formats %s without rounding away known spend", (amount, display) => {
    expect(formatUsd(amount, "en-US")).toBe(display);
  });
  it("uses localized currency placement, grouping and decimal separators", () => {
    expect(formatUsd("1234.000000000001", "de-DE")).toBe("1.234,000000000001 $");
  });
});
