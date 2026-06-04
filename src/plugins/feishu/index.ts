import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { Plugin, PluginContext } from "../types.js";
import { FeishuClient } from "./client.js";
import { processFeishuMessage } from "./handler.js";
import type { AgentActor } from "../../types.js";

interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
}

let wsClient: WSClient | null = null;

const feishuPlugin: Plugin = {
  name: "feishu",

  async init(ctx: PluginContext): Promise<void> {
    const cfg = ctx.config as FeishuConfig;

    if (!cfg.appId || !cfg.appSecret) {
      ctx.log("WARN", "缺少 appId 或 appSecret，飞书插件已加载但不可用");
      return;
    }

    const feishuClient = new FeishuClient(cfg.appId, cfg.appSecret);

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

    wsClient = new WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
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
  },

  async destroy(): Promise<void> {
    if (wsClient) {
      wsClient.close();
      wsClient = null;
    }
  },
};

function stripMention(text: string): string {
  return text.replace(/@\S+\s?/g, "").trim();
}

export default feishuPlugin;
