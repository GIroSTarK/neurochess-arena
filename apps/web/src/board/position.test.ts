import { describe, expect, it } from "vitest";

import { snapshot } from "../test/fixtures";

import { parsePosition, visualRows } from "./position";

describe("defensive presentation parser", () => {
  it("projects server FEN pieces, coordinates and side without adjudication", () => {
    const position = parsePosition(snapshot(["e2e4"]).fen);
    expect(position?.pieces.size).toBe(32);
    expect(position?.pieces.get("e4")).toEqual({ color: "white", kind: "p" });
    expect(position?.pieces.has("e2")).toBe(false);
    expect(position?.turn).toBe("black");
    expect(visualRows("white")[0]).toEqual(["a8", "b8", "c8", "d8", "e8", "f8", "g8", "h8"]);
    expect(visualRows("black")[0]).toEqual(["h1", "g1", "f1", "e1", "d1", "c1", "b1", "a1"]);
  });

  it.each([
    "",
    "8/8/8/8/8/8/8 w - - 0 1",
    "9/8/8/8/8/8/8/8 w - - 0 1",
    "7/8/8/8/8/8/8/8 w - - 0 1",
    "8K/8/8/8/8/8/8/8 w - - 0 1",
    "8/8/8/8/8/8/8/X7 w - - 0 1",
    "8/8/8/8/8/8/8/8 x - - 0 1",
    "8/8/8/8/8/8/8/8 w <script> - 0 1",
    "8/8/8/8/8/8/8/8 w - e4 0 1",
    "8/8/8/8/8/8/8/8 w - - -1 1",
    "8/8/8/8/8/8/8/8 w - - 0 0",
    "8/8/8/8/8/8/8/8 w - - 9007199254740992 1",
    " ".repeat(200),
  ])("rejects malformed presentation input", (fen) => {
    expect(parsePosition(fen)).toBeNull();
  });
});
