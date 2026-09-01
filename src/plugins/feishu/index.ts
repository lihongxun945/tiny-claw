import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { KernelPlugin } from "../../kernel/plugin.js";
import { FeishuClient } from "./client.js";
import { processFeishuMessage } from "./handler.js";
import type { AgentActor } from "../../types.js";

interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
}

const feishuPlugin: KernelPlugin = {
  manifest: {
    id: "feishu",
    version: "1.0.0",
    kind: "builtin",
    description: "通过飞书长连接收发消息",
    config: {
      fields: {
        appId: { type: "string", title: "App ID", description: "飞书自建应用 App ID", required: true },
        appSecret: { type: "string", title: "App Secret", description: "飞书自建应用 App Secret", required: true, secret: true },
        verificationToken: { type: "string", title: "Verification Token", description: "事件订阅 Verification Token", secret: true },
      },
    },
    permissions: {
      network: { hosts: ["open.feishu.cn"] },
    },
  },

  async setup(ctx) {
    const cfg = ctx.config as FeishuConfig;
    const appId = cfg.appId!;
    const appSecret = cfg.appSecret!;

    const feishuClient = new FeishuClient(appId, appSecret);

    const eventDispatcher = new EventDispatcher({
      verificationToken: cfg.verificationToken ?? "",
    }).register({
      "im.message.receive_v1": async (data) => {
        if (data.message.message_type !== "text") return;

        let userText: string;
        try {
          const content = JSON.parse(data.message.content) as { text?: string };
          userText = content.text ?? "";
        } catch {
          return;
        }

        userText = stripMention(userText);
        if (!userText) return;

        const chatId = data.message.chat_id;
        const messageId = data.message.message_id;
        const requesterId = data.sender.sender_id?.open_id;
        if (!requesterId) return;
        const session = ctx.getOrCreateSession(chatId, "feishu");
        const actor: AgentActor = { channel: "feishu", requesterId, chatId };

        feishuClient.addReaction(messageId, "THINKING").catch(() => {});

        processFeishuMessage(
          session,
          userText,
          messageId,
          feishuClient,
          ctx.workspacePath,
          actor,
          async (input, commandActor) => {
            const result = await ctx.executeChatCommand(input, {
              sessionId: session.id,
              channel: "feishu",
              actor: commandActor,
            });
            return result?.text;
          },
        ).then(() => {
          feishuClient.deleteReaction(messageId, "THINKING").catch(() => {});
          feishuClient.addReaction(messageId, "DONE").catch(() => {});
        }).catch((err) => {
          feishuClient.deleteReaction(messageId, "THINKING").catch(() => {});
          feishuClient.addReaction(messageId, "ERROR").catch(() => {});
          ctx.log("ERROR", `消息处理失败: ${err instanceof Error ? err.message : String(err)}`, session.id);
        });
      },
    });

    const wsClient = new WSClient({
      appId,
      appSecret,
      onReady: () => {
        ctx.log("INFO", "飞书长连接已建立");
      },
      onError: (err) => {
        ctx.log("ERROR", `飞书长连接失败: ${err.message}`);
      },
      onReconnecting: () => {
        ctx.log("WARN", "飞书长连接断开，正在重连...");
      },
      onReconnected: () => {
        ctx.log("INFO", "飞书长连接已恢复");
      },
    });

    await wsClient.start({ eventDispatcher });
    ctx.log("INFO", "飞书插件已初始化（长连接模式）");
    return { dispose: () => wsClient.close() };
  },
};

function stripMention(text: string): string {
  return text.replace(/@\S+\s?/g, "").trim();
}

export default feishuPlugin;
