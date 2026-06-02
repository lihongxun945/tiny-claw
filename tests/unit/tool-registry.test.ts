import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("ToolRegistry", () => {
  it("registers tools and exposes model definitions", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo input",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (args) => String(args.text),
    });

    expect(registry.getDefinitions()).toEqual([{
      name: "echo",
      description: "Echo input",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    }]);
    expect(await registry.getTool("echo")?.execute({ text: "hello" })).toBe("hello");
  });

  it("replaces a tool registered with the same name", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "first",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "first",
    });
    registry.register({
      name: "echo",
      description: "second",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "second",
    });

    expect(registry.getDefinitions()).toHaveLength(1);
    expect(registry.getDefinitions()[0].description).toBe("second");
    expect(await registry.getTool("echo")?.execute({})).toBe("second");
  });
});
