import type { KernelPlugin } from "../../../src/kernel/plugin.js";

interface GreeterConfig {
  greeting?: string;
}

export default {
  manifest: {
    id: "example-greeter",
    version: "1.0.0",
    kind: "workspace",
    description: "示例插件：注册一个可配置的 /greet 聊天命令",
    config: {
      fields: {
        greeting: {
          type: "string",
          title: "问候语",
          description: "执行 /greet 时显示在名字前的文本。",
          default: "你好",
        },
      },
    },
    permissions: {},
  },
  setup(ctx) {
    const config = ctx.config as Readonly<GreeterConfig>;
    ctx.registerChatCommand({
      name: "greet",
      description: "示例插件：向指定名字问好",
      usage: "/greet [名字]",
      execute(command) {
        const name = command.rawArgs.trim() || "breeze-coder 用户";
        return { text: `${config.greeting || "你好"}，${name}！` };
      },
    });
  },
} satisfies KernelPlugin;
