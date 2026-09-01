import semver from "semver";
import type { KernelPlugin } from "./plugin.js";

export interface PluginGraphResult {
  startOrder: string[];
  issues: Map<string, Error>;
}

export class PluginGraph {
  constructor(private readonly plugins: ReadonlyMap<string, KernelPlugin>) {}

  analyze(): PluginGraphResult {
    const issues = new Map<string, Error>();
    const dependencies = new Map<string, Set<string>>();

    for (const [id, plugin] of this.plugins) {
      const manifest = plugin.manifest;
      if (!semver.valid(manifest.version)) {
        issues.set(id, new Error(`插件 ${id} 的版本无效: ${manifest.version}`));
        continue;
      }
      const deps = new Set<string>();
      for (const [dependencyId, range] of Object.entries(manifest.requires ?? {})) {
        if (dependencyId === id) {
          issues.set(id, new Error(`插件 ${id} 不能依赖自身`));
          continue;
        }
        const dependency = this.plugins.get(dependencyId);
        if (!dependency) {
          issues.set(id, new Error(`插件 ${id} 缺少必需依赖 ${dependencyId}@${range}`));
          continue;
        }
        if (!semver.validRange(range) || !semver.satisfies(dependency.manifest.version, range)) {
          issues.set(id, new Error(
            `插件 ${id} 需要 ${dependencyId}@${range}，实际为 ${dependency.manifest.version}`,
          ));
          continue;
        }
        deps.add(dependencyId);
      }
      for (const [dependencyId, range] of Object.entries(manifest.optional ?? {})) {
        const dependency = this.plugins.get(dependencyId);
        if (dependency && semver.validRange(range) && semver.satisfies(dependency.manifest.version, range)) {
          deps.add(dependencyId);
        }
      }
      dependencies.set(id, deps);
    }

    this.markCycles(dependencies, issues);
    this.propagateIssues(dependencies, issues);

    const validIds = [...this.plugins.keys()].filter((id) => !issues.has(id));
    const indegree = new Map(validIds.map((id) => [id, 0]));
    const dependents = new Map<string, string[]>();
    for (const id of validIds) {
      for (const dependencyId of dependencies.get(id) ?? []) {
        if (!indegree.has(dependencyId)) continue;
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
        const values = dependents.get(dependencyId) ?? [];
        values.push(id);
        dependents.set(dependencyId, values);
      }
    }
    const queue = validIds.filter((id) => indegree.get(id) === 0);
    const startOrder: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      startOrder.push(id);
      for (const dependent of dependents.get(id) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) queue.push(dependent);
      }
    }
    return { startOrder, issues };
  }

  getDependents(pluginId: string): string[] {
    return [...this.plugins.values()]
      .filter((plugin) => Object.hasOwn(plugin.manifest.requires ?? {}, pluginId))
      .map((plugin) => plugin.manifest.id);
  }

  private markCycles(dependencies: Map<string, Set<string>>, issues: Map<string, Error>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        const start = path.indexOf(id);
        const cycle = [...path.slice(start), id];
        for (const pluginId of cycle) issues.set(pluginId, new Error(`插件依赖存在循环: ${cycle.join(" -> ")}`));
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      path.push(id);
      for (const dependencyId of dependencies.get(id) ?? []) visit(dependencyId);
      path.pop();
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of dependencies.keys()) visit(id);
  }

  private propagateIssues(dependencies: Map<string, Set<string>>, issues: Map<string, Error>): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, deps] of dependencies) {
        if (issues.has(id)) continue;
        const failedDependency = [...deps].find((dependencyId) => issues.has(dependencyId));
        if (!failedDependency) continue;
        issues.set(id, new Error(`插件 ${id} 因依赖 ${failedDependency} 无法启动: ${issues.get(failedDependency)!.message}`));
        changed = true;
      }
    }
  }
}
