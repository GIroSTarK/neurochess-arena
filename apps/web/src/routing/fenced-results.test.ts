import { describe, expect, it } from "vitest";

import { FencedResults } from "./fenced-results";
import type { ScopedRouteData } from "./route-runtime";

interface Data {
  access: "account";
  rows: string[] | null;
  error: boolean;
}
const result = (): ScopedRouteData<Data> => ({
  generation: 1,
  data: { access: "account", rows: ["private"], error: false },
});
const cache = () =>
  new FencedResults<Data>((data) => {
    data.rows = null;
  });

describe("fenced route results", () => {
  it("clears every issued page in place and fences reads started before deletion", () => {
    const results = cache();
    const read = results.beginRead();
    const initial = read(result());
    const cursor = read(result());
    results.invalidate();
    expect(initial.data?.rows).toBeNull();
    expect(cursor.data?.rows).toBeNull();
    expect(read(result()).data).toEqual({ access: "account", rows: null, error: false });
    expect(results.beginRead()(result()).data?.rows).toEqual(["private"]);
  });
  it("can fence old reads after a save while retaining already-issued metadata", () => {
    const results = cache();
    const read = results.beginRead();
    const initial = read(result());
    results.invalidate(false);
    expect(initial.data?.rows).toEqual(["private"]);
    expect(read(result()).data?.rows).toBeNull();
    results.invalidate();
    expect(initial.data?.rows).toBeNull();
  });
  it("never restores a result cleared by the identity runtime", () => {
    const results = cache();
    const read = results.beginRead();
    const cleared = read(result());
    cleared.data = null;
    results.invalidate();
    expect(cleared.data).toBeNull();
    expect(read(cleared).data).toBeNull();
  });
});
