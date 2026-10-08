import { IssuedResults } from "./issued-results";
import type { ScopedRouteData } from "./route-runtime";

export class FencedResults<T> {
  private revision = 0;
  private readonly issued = new IssuedResults<ScopedRouteData<T>>();

  constructor(private readonly clearData: (data: T) => void) {}

  beginRead() {
    const revision = this.revision;
    return (result: ScopedRouteData<T>) => {
      if (revision !== this.revision && result.data !== null) this.clearData(result.data);
      this.issued.track(result);
      return result;
    };
  }

  invalidate(clearIssued = true) {
    // A pre-mutation read cannot restore removed data after a failed refresh.
    this.revision++;
    if (!clearIssued) return;
    this.issued.forEach((result) => {
      if (result.data !== null) this.clearData(result.data);
    });
    this.issued.clear();
  }
}
