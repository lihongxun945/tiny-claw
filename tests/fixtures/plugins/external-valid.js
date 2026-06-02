export default {
  name: "external-valid",
  async init(ctx) {
    ctx.registerTool({
      name: "external_echo",
      description: "Echo external plugin input",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "external",
    });
  },
};
