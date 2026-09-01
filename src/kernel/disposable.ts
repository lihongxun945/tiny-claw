export interface Disposable {
  dispose(): void | Promise<void>;
}

export class DisposableStore implements Disposable {
  private readonly items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      void item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const item of this.items.reverse()) {
      try {
        await item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.items.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose resources");
  }
}
