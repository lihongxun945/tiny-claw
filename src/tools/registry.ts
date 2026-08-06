import type { ExecutionMode, SessionContext, Tool, ToolDefinition } from "../types.js";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(context?: SessionContext, executionMode: ExecutionMode = "normal"): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter((tool) => !context || !tool.isAvailable || tool.isAvailable(context, executionMode))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
  }
}
