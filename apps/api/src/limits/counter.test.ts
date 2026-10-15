import { describe, expect, it } from "vitest";

import { createCounter } from "./counter.js";

describe("bounded request counters", () => {
  it("counts synchronously, reports remaining wait, and recovers without extending rejection", () => {
    let now = 0;
    const counter = createCounter(2, 60_000, 2, () => now);
    expect(counter.consume("a")).toBe(0);
    expect(counter.consume("a")).toBe(0);
    now = 1200;
    expect(counter.consume("a")).toBe(59);
    now = 59_999;
    expect(counter.consume("a")).toBe(1);
    now = 60_000;
    expect(counter.consume("a")).toBe(0);
  });

  it("fails closed at capacity without evicting a live quota and reclaims expired entries", () => {
    let now = 0;
    const counter = createCounter(1, 60_000, 2, () => now);
    expect(counter.consume("a")).toBe(0);
    now = 1000;
    expect(counter.consume("b")).toBe(0);
    for (let i = 0; i < 10_000; i++) expect(counter.consume(`new-${i}`)).toBe(59);
    expect(counter.consume("a")).toBe(59);
    now = 60_000;
    expect(counter.consume("new")).toBe(0);
    expect(counter.consume("b")).toBe(1);
  });
});
