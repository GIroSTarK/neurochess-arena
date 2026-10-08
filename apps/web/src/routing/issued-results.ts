export class IssuedResults<T extends object> {
  private readonly references = new Set<WeakRef<T>>();

  track(value: T) {
    this.forEach();
    this.references.add(new WeakRef(value));
  }

  forEach(visit?: (value: T) => void) {
    for (const reference of this.references) {
      const value = reference.deref();
      if (value) visit?.(value);
      else this.references.delete(reference);
    }
  }

  clear() {
    this.references.clear();
  }
}
