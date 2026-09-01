import { afterEach, describe, expect, it, vi } from "vitest";
import { capability, multiCapability } from "../../src/kernel/capability.js";
import {
  CapabilityConflictError,
  CapabilityNotFoundError,
  CapabilityRegistry,
} from "../../src/kernel/registry.js";
import { ApplicationScope, scopeValue } from "../../src/kernel/scope.js";
import { TOOL_CAPABILITY } from "../../src/kernel/builtin-capabilities.js";
import { PluginManager } from "../../src/plugin-manager.js";
import { createTempWorkspace, removeTempWorkspace } from "../helpers/temp-workspace.js";

describe("kernel capability registry", () => {
  it("selects a single provider by priority and reports equal-priority conflicts", () => {
    const token = capability<string>("test.single");
    const registry = new CapabilityRegistry();
    registry.provide(token, "default", { pluginId: "default", priority: 10 });
    const preferred = registry.provide(token, "preferred", { pluginId: "preferred", priority: 20 });
    expect(registry.resolve(token)).toBe("preferred");

    preferred.dispose();
    expect(registry.resolve(token)).toBe("default");
    registry.provide(token, "conflict", { pluginId: "conflict", priority: 10 });
    expect(() => registry.resolve(token)).toThrow(CapabilityConflictError);
  });

  it("orders multiple contributions and removes disposed registrations", () => {
    const token = multiCapability<string>("test.multiple");
    const registry = new CapabilityRegistry();
    const low = registry.contribute(token, "low", { pluginId: "low", priority: 1 });
    registry.contribute(token, "high", { pluginId: "high", priority: 2 });
    expect(registry.resolveAll(token)).toEqual(["high", "low"]);
    low.dispose();
    expect(registry.resolveAll(token)).toEqual(["high"]);
  });

  it("uses local single providers as scope overrides and inherits contributions", () => {
    const single = capability<string>("test.override");
    const multiple = multiCapability<string>("test.inherited");
    const parent = new CapabilityRegistry();
    const child = new CapabilityRegistry(parent);
    parent.provide(single, "application", { pluginId: "application" });
    parent.contribute(multiple, "parent", { pluginId: "application" });
    child.provide(single, "session", { pluginId: "session" });
    child.contribute(multiple, "child", { pluginId: "session" });

    expect(child.resolve(single)).toBe("session");
    expect(child.resolveAll(multiple)).toEqual(["child", "parent"]);
    expect(() => parent.resolve(capability<string>("missing"))).toThrow(CapabilityNotFoundError);
  });

  it("does not allow child scopes to change inherited capability cardinality", () => {
    const parent = new CapabilityRegistry();
    const child = new CapabilityRegistry(parent);
    parent.provide(capability<string>("test.cardinality"), "parent", { pluginId: "parent" });

    expect(() => child.contribute(
      multiCapability<string>("test.cardinality"),
      "child",
      { pluginId: "child" },
    )).toThrow(/different cardinality/);
  });
});

describe("kernel runtime scopes", () => {
  it("isolates sibling state, inherits parent state and recursively disposes resources", async () => {
    const application = new ApplicationScope();
    const sessionA = application.createSession("session-a");
    const sessionB = application.createSession("session-b");
    const turn = sessionA.createTurn("turn-a");
    const value = scopeValue<string>("test value");
    const disposeTurn = vi.fn();
    const disposeSession = vi.fn();
    application.set(value, "application");
    sessionA.set(value, "session-a");
    turn.disposables.add({ dispose: disposeTurn });
    sessionA.disposables.add({ dispose: disposeSession });

    expect(turn.get(value)).toBe("session-a");
    expect(sessionB.get(value)).toBe("application");
    await application.dispose();
    expect(disposeTurn).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledOnce();
    expect(() => application.createSession("late")).toThrow(/disposed/);
  });
});

describe("PluginManager capability compatibility", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) removeTempWorkspace(workspace);
  });

  it("mirrors existing core tool registrations into the application scope", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);
    const manager = new PluginManager(workspace);
    await manager.loadCorePlugins();

    const tools = manager.applicationScope.capabilities.resolveAll(TOOL_CAPABILITY);
    expect(tools.map((tool) => tool.name)).toContain("bash");
    expect(tools.find((tool) => tool.name === "bash")).toBe(manager.getTool("bash"));

    await manager.destroy();
    expect(manager.applicationScope.capabilities.resolveAll(TOOL_CAPABILITY)).toEqual([]);
  });

  it("removes and restores a plugin's capabilities across stop and start", async () => {
    const workspace = createTempWorkspace();
    workspaces.push(workspace);
    const manager = new PluginManager(workspace);
    await manager.loadCorePlugins();

    expect(manager.getTool("bash")).toBeDefined();
    expect(manager.listPlugins()).toContainEqual(expect.objectContaining({ id: "core-tools", state: "active" }));
    await manager.stopPlugin("core-tools");
    expect(manager.getTool("bash")).toBeUndefined();
    expect(manager.listPlugins()).toContainEqual(expect.objectContaining({ id: "core-tools", state: "stopped" }));

    await manager.startPlugin("core-tools");
    expect(manager.getTool("bash")).toBeDefined();
    expect(manager.listPlugins()).toContainEqual(expect.objectContaining({ id: "core-tools", state: "active" }));
    await manager.destroy();
  });
});
