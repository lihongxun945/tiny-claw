import { CapabilityRegistry } from "./registry.js";
import { DisposableStore, type Disposable } from "./disposable.js";

export interface ScopeValueToken<T> {
  readonly id: symbol;
  readonly description: string;
  readonly __type?: T;
}

export function scopeValue<T>(description: string): ScopeValueToken<T> {
  return { id: Symbol(description), description };
}

abstract class RuntimeScope implements Disposable {
  readonly capabilities: CapabilityRegistry;
  readonly disposables = new DisposableStore();
  private readonly children = new Set<RuntimeScope>();
  private readonly values = new Map<symbol, unknown>();
  private disposed = false;

  protected constructor(
    readonly kind: "application" | "session" | "turn",
    readonly id: string,
    readonly parent?: RuntimeScope,
  ) {
    this.capabilities = new CapabilityRegistry(parent?.capabilities);
    parent?.children.add(this);
  }

  set<T>(token: ScopeValueToken<T>, value: T): void {
    this.assertActive();
    this.values.set(token.id, value);
  }

  get<T>(token: ScopeValueToken<T>): T | undefined {
    if (this.values.has(token.id)) return this.values.get(token.id) as T;
    return this.parent?.get(token);
  }

  delete<T>(token: ScopeValueToken<T>): void {
    this.assertActive();
    this.values.delete(token.id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const child of [...this.children].reverse()) {
      try {
        await child.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.children.clear();
    this.values.clear();
    this.parent?.children.delete(this);
    try {
      await this.disposables.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, `Failed to dispose ${this.kind} scope ${this.id}`);
  }

  protected assertActive(): void {
    if (this.disposed) throw new Error(`${this.kind} scope ${this.id} has been disposed`);
  }
}

export class ApplicationScope extends RuntimeScope {
  constructor(id = "application") {
    super("application", id);
  }

  createSession(sessionId: string): SessionScope {
    this.assertActive();
    return new SessionScope(sessionId, this);
  }
}

export class SessionScope extends RuntimeScope {
  constructor(sessionId: string, parent: ApplicationScope) {
    super("session", sessionId, parent);
  }

  createTurn(turnId: string): TurnScope {
    this.assertActive();
    return new TurnScope(turnId, this);
  }
}

export class TurnScope extends RuntimeScope {
  constructor(turnId: string, parent: SessionScope) {
    super("turn", turnId, parent);
  }
}
