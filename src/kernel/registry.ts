import type { CapabilityToken } from "./capability.js";
import type { Disposable } from "./disposable.js";

export interface CapabilityRegistrationOptions {
  pluginId: string;
  priority?: number;
}

interface CapabilityEntry<T> {
  value: T;
  pluginId: string;
  priority: number;
  order: number;
}

export class CapabilityNotFoundError extends Error {}
export class CapabilityConflictError extends Error {}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry<unknown>[]>();
  private readonly modes = new Map<string, boolean>();
  private nextOrder = 0;

  constructor(private readonly parent?: CapabilityRegistry) {}

  provide<T>(token: CapabilityToken<T>, value: T, options: CapabilityRegistrationOptions): Disposable {
    if (token.multiple) throw new Error(`Capability ${token.id} accepts multiple contributions; use contribute()`);
    return this.register(token, value, options);
  }

  contribute<T>(token: CapabilityToken<T>, value: T, options: CapabilityRegistrationOptions): Disposable {
    if (!token.multiple) throw new Error(`Capability ${token.id} accepts one provider; use provide()`);
    return this.register(token, value, options);
  }

  resolve<T>(token: CapabilityToken<T>): T {
    if (token.multiple) throw new Error(`Capability ${token.id} has multiple contributions; use resolveAll()`);
    const local = this.getLocalEntries<T>(token);
    if (local.length === 0) {
      if (this.parent) return this.parent.resolve(token);
      throw new CapabilityNotFoundError(`Capability not found: ${token.id}`);
    }
    const sorted = sortEntries(local);
    if (sorted.length > 1 && sorted[0].priority === sorted[1].priority) {
      throw new CapabilityConflictError(
        `Capability ${token.id} has conflicting providers at priority ${sorted[0].priority}: ${sorted[0].pluginId}, ${sorted[1].pluginId}`,
      );
    }
    return sorted[0].value;
  }

  tryResolve<T>(token: CapabilityToken<T>): T | undefined {
    try {
      return this.resolve(token);
    } catch (error) {
      if (error instanceof CapabilityNotFoundError) return undefined;
      throw error;
    }
  }

  resolveAll<T>(token: CapabilityToken<T>): T[] {
    if (!token.multiple) throw new Error(`Capability ${token.id} has one provider; use resolve()`);
    const inherited = this.parent?.resolveAll(token) ?? [];
    const local = sortEntries(this.getLocalEntries<T>(token)).map((entry) => entry.value);
    return [...local, ...inherited];
  }

  private register<T>(token: CapabilityToken<T>, value: T, options: CapabilityRegistrationOptions): Disposable {
    const knownMode = this.getDeclaredMode(token.id);
    if (knownMode !== undefined && knownMode !== token.multiple) {
      throw new Error(`Capability ${token.id} was declared with a different cardinality`);
    }
    this.modes.set(token.id, token.multiple);
    const entry: CapabilityEntry<T> = {
      value,
      pluginId: options.pluginId,
      priority: options.priority ?? 0,
      order: this.nextOrder++,
    };
    const current = this.entries.get(token.id) ?? [];
    current.push(entry as CapabilityEntry<unknown>);
    this.entries.set(token.id, current);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        const entries = this.entries.get(token.id);
        if (!entries) return;
        const index = entries.indexOf(entry as CapabilityEntry<unknown>);
        if (index >= 0) entries.splice(index, 1);
        if (entries.length === 0) this.entries.delete(token.id);
      },
    };
  }

  private getLocalEntries<T>(token: CapabilityToken<T>): CapabilityEntry<T>[] {
    return (this.entries.get(token.id) ?? []) as CapabilityEntry<T>[];
  }

  private getDeclaredMode(id: string): boolean | undefined {
    return this.modes.get(id) ?? this.parent?.getDeclaredMode(id);
  }
}

function sortEntries<T>(entries: CapabilityEntry<T>[]): CapabilityEntry<T>[] {
  return [...entries].sort((a, b) => b.priority - a.priority || a.order - b.order);
}
