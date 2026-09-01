import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugins/types.js";
import type { Disposable, DisposableStore } from "../../src/kernel/disposable.js";
import { PluginGraph } from "../../src/kernel/plugin-graph.js";
import { PluginHost } from "../../src/kernel/plugin-host.js";
import { adaptLegacyPlugin, type KernelPlugin, type PluginKind } from "../../src/kernel/plugin.js";
import { resolvePluginConfig } from "../../src/kernel/plugin-config.js";

function plugin(
  id: string,
  setup: KernelPlugin["setup"] = () => {},
  options: {
    kind?: PluginKind;
    version?: string;
    requires?: Record<string, string>;
    optional?: Record<string, string>;
  } = {},
): KernelPlugin {
  return {
    manifest: {
      id,
      version: options.version ?? "1.0.0",
      kind: options.kind ?? "external",
      requires: options.requires,
      optional: options.optional,
      permissions: { tools: ["temporary"], gatewayRoutes: true },
    },
    setup,
  };
}

function host(createContext: (id: string, store: DisposableStore) => PluginContext = () => ({} as PluginContext)): PluginHost {
  return new PluginHost(createContext);
}

describe("PluginGraph", () => {
  it("sorts required and available optional dependencies before dependents", () => {
    const plugins = new Map<string, KernelPlugin>([
      ["feature", plugin("feature", undefined, { requires: { base: "^1.0.0" }, optional: { optional: "*" } })],
      ["optional", plugin("optional")],
      ["base", plugin("base")],
    ]);

    const result = new PluginGraph(plugins).analyze();
    expect(result.issues.size).toBe(0);
    expect(result.startOrder.indexOf("base")).toBeLessThan(result.startOrder.indexOf("feature"));
    expect(result.startOrder.indexOf("optional")).toBeLessThan(result.startOrder.indexOf("feature"));
  });

  it("reports missing, incompatible, and cyclic dependencies", () => {
    const plugins = new Map<string, KernelPlugin>([
      ["missing", plugin("missing", undefined, { requires: { absent: "^1.0.0" } })],
      ["old", plugin("old", undefined, { version: "1.0.0" })],
      ["incompatible", plugin("incompatible", undefined, { requires: { old: "^2.0.0" } })],
      ["cycle-a", plugin("cycle-a", undefined, { requires: { "cycle-b": "*" } })],
      ["cycle-b", plugin("cycle-b", undefined, { requires: { "cycle-a": "*" } })],
    ]);

    const { issues } = new PluginGraph(plugins).analyze();
    expect(issues.get("missing")?.message).toContain("缺少必需依赖");
    expect(issues.get("incompatible")?.message).toContain("实际为 1.0.0");
    expect(issues.get("cycle-a")?.message).toContain("循环");
    expect(issues.get("cycle-b")?.message).toContain("循环");
  });
});

describe("PluginHost", () => {
  it("starts in dependency order and stops in reverse order", async () => {
    const calls: string[] = [];
    const pluginHost = host();
    pluginHost.register(plugin("feature", () => {
      calls.push("start-feature");
      return { dispose: () => { calls.push("stop-feature"); } };
    }, { requires: { base: "^1.0.0" } }));
    pluginHost.register(plugin("base", () => {
      calls.push("start-base");
      return { dispose: () => { calls.push("stop-base"); } };
    }));

    await pluginHost.startAll();
    await pluginHost.stopAll();
    expect(calls).toEqual(["start-base", "start-feature", "stop-feature", "stop-base"]);
  });

  it("isolates user failures and blocks their dependents", async () => {
    const independent = vi.fn();
    const pluginHost = host();
    pluginHost.register(plugin("failed", () => { throw new Error("boom"); }));
    pluginHost.register(plugin("dependent", () => {}, { requires: { failed: "*" } }));
    pluginHost.register(plugin("independent", independent));

    await pluginHost.startAll();
    expect(pluginHost.getPlugin("failed")?.state).toBe("failed");
    expect(pluginHost.getPlugin("dependent")?.state).toBe("blocked");
    expect(pluginHost.getPlugin("independent")?.state).toBe("active");
    expect(independent).toHaveBeenCalledOnce();
  });

  it("blocks new user plugins without permission declarations", async () => {
    const setup = vi.fn();
    const pluginHost = host();
    const undeclared = plugin("undeclared", setup);
    delete undeclared.manifest.permissions;
    pluginHost.register(undeclared);

    await pluginHost.startAll();
    expect(setup).not.toHaveBeenCalled();
    expect(pluginHost.getPlugin("undeclared")).toMatchObject({
      state: "blocked",
      permissions: { issues: [expect.objectContaining({ severity: "error" })] },
    });
  });

  it("blocks plugins with invalid private configuration", async () => {
    const setup = vi.fn();
    const configured = plugin("configured", setup);
    configured.manifest.config = { fields: { token: { type: "string", title: "Token", required: true, secret: true } } };
    const pluginHost = new PluginHost(
      () => ({} as PluginContext),
      (candidate) => resolvePluginConfig(candidate.manifest.config, {}),
    );
    pluginHost.register(configured);

    await pluginHost.startAll();
    expect(setup).not.toHaveBeenCalled();
    expect(pluginHost.getPlugin("configured")).toMatchObject({ state: "blocked", config: { valid: false } });
  });

  it("fails startup for invalid core plugins and rolls back started plugins", async () => {
    const dispose = vi.fn();
    const pluginHost = host();
    pluginHost.register(plugin("base", () => ({ dispose }), { kind: "core" }));
    pluginHost.register(plugin("broken", () => {}, { kind: "core", requires: { absent: "*" } }));

    await expect(pluginHost.startAll()).rejects.toThrow("缺少必需依赖");
    expect(pluginHost.getPlugin("broken")?.state).toBe("blocked");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rolls back previously started core plugins when a later core setup fails", async () => {
    const dispose = vi.fn();
    const pluginHost = host();
    pluginHost.register(plugin("base", () => ({ dispose }), { kind: "core" }));
    pluginHost.register(plugin("broken", () => { throw new Error("core failed"); }, {
      kind: "core",
      requires: { base: "*" },
    }));

    await expect(pluginHost.startAll()).rejects.toThrow("core failed");
    expect(dispose).toHaveBeenCalledOnce();
    expect(pluginHost.getPlugin("base")?.state).toBe("stopped");
  });

  it("prevents stopping active dependencies and supports reload with a fresh resource store", async () => {
    const cleanups: number[] = [];
    let generation = 0;
    const pluginHost = host();
    pluginHost.register(plugin("base", () => {
      const current = ++generation;
      return { dispose: () => { cleanups.push(current); } };
    }));
    pluginHost.register(plugin("dependent", () => {}, { requires: { base: "*" } }));
    await pluginHost.startAll();

    await expect(pluginHost.stopPlugin("base")).rejects.toThrow("仍被活动插件依赖");
    await pluginHost.stopPlugin("dependent");
    await pluginHost.reloadPlugin("base");
    expect(generation).toBe(2);
    expect(cleanups).toEqual([1]);
    expect(pluginHost.getPlugin("base")?.state).toBe("active");
    expect(pluginHost.getPlugin("dependent")?.state).toBe("stopped");
  });

  it("keeps disabled plugins discoverable without registering capabilities", async () => {
    const setup = vi.fn();
    const pluginHost = host();
    pluginHost.register(plugin("optional-feature", setup));
    pluginHost.setInitialEnabled("optional-feature", false);

    await pluginHost.startAll();
    expect(setup).not.toHaveBeenCalled();
    expect(pluginHost.getPlugin("optional-feature")).toMatchObject({ enabled: false, canToggle: true, state: "registered" });

    await pluginHost.setPluginEnabled("optional-feature", true);
    expect(setup).toHaveBeenCalledOnce();
    expect(pluginHost.getPlugin("optional-feature")).toMatchObject({ enabled: true, state: "active" });
  });

  it("does not allow core plugins or active required dependencies to be disabled", async () => {
    const pluginHost = host();
    pluginHost.register(plugin("core", () => {}, { kind: "core" }));
    pluginHost.register(plugin("base"));
    pluginHost.register(plugin("dependent", undefined, { requires: { base: "*" } }));
    await pluginHost.startAll();

    await expect(pluginHost.setPluginEnabled("core", false)).rejects.toThrow("核心插件");
    await expect(pluginHost.setPluginEnabled("base", false)).rejects.toThrow("仍被活动插件依赖");
  });

  it("uses a newly loaded plugin instance when a reloader is available", async () => {
    const calls: string[] = [];
    const pluginHost = host();
    pluginHost.register(
      plugin("reloadable", () => { calls.push("first"); }),
      async () => plugin("reloadable", () => { calls.push("second"); }),
    );

    await pluginHost.startAll();
    await pluginHost.reloadPlugin("reloadable");
    expect(calls).toEqual(["first", "second"]);
    expect(pluginHost.getPlugin("reloadable")?.state).toBe("active");
  });

  it("rolls back capabilities registered before setup fails", async () => {
    const capabilities = new Set<string>();
    const createContext = (_id: string, store: DisposableStore): PluginContext => ({
      registerTool(tool): Disposable {
        capabilities.add(tool.name);
        const registration = { dispose: () => { capabilities.delete(tool.name); } };
        store.add(registration);
        return registration;
      },
    } as PluginContext);
    const pluginHost = host(createContext);
    pluginHost.register(plugin("broken", (ctx) => {
      ctx.registerTool({ name: "temporary", description: "temporary", inputSchema: { type: "object", properties: {} } });
      throw new Error("setup failed");
    }));

    await pluginHost.startAll();
    expect(capabilities).toEqual(new Set());
    expect(pluginHost.getPlugin("broken")?.state).toBe("failed");
  });

  it("adapts legacy init and destroy lifecycle", async () => {
    const init = vi.fn();
    const destroy = vi.fn();
    const pluginHost = host();
    pluginHost.register(adaptLegacyPlugin({ name: "legacy", init, destroy }, "workspace"));

    await pluginHost.startAll();
    await pluginHost.stopAll();
    expect(init).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
