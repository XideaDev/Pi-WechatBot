/**
 * 微信智能助手 · Agent 进程内扩展
 * 由 PI-Desktop Agent 运行时加载（manifest.contributes.agentExtensions）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";

const EXTENSION_DIR = path.dirname(new URL(import.meta.url).pathname);
const PLUGIN_DIR = path.resolve(EXTENSION_DIR, "..");
const DATA_DIR = path.join(PLUGIN_DIR, "data");
const IPC_FILE = path.join(DATA_DIR, "ipc.json");

let cachedIpcPort = 0;

function getIpcPort() {
  if (cachedIpcPort > 0) return cachedIpcPort;
  try {
    if (fs.existsSync(IPC_FILE)) {
      const data = JSON.parse(fs.readFileSync(IPC_FILE, "utf8"));
      cachedIpcPort = Number(data.port) || 0;
      return cachedIpcPort;
    }
  } catch {}
  return 0;
}

/**
 * 向插件主进程发送事件
 */
function sendToMain(payload) {
  const port = getIpcPort();
  if (!port) return;

  const data = JSON.stringify(payload);
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 3000,
    },
    (res) => {
      res.resume();
    }
  );

  req.on("error", () => {});
  req.write(data);
  req.end();
}

/**
 * 提取消息纯文本
 */
function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * 扩展入口函数：由宿主 Agent 运行时注入 api
 */
export default function wechatAgentExtension(api) {
  let isCurrentTurnWechat = false;

  // 1. 监听 Agent 开始轮次
  api.on("agent_start", (event, ctx) => {
    isCurrentTurnWechat = false;
    const sessionId = ctx?.sessionId || event?.sessionId || "";

    sendToMain({
      type: "agent_start",
      sessionId,
      timestamp: Date.now(),
    });
  });

  // 2. 检查用户输入是否来自微信，若是，标记当前轮次为微信驱动
  api.on("user_message", (event, ctx) => {
    const text = extractText(event?.message?.content);
    if (text.includes("[微信]")) {
      isCurrentTurnWechat = true;
    }
  });

  // 3. 拦截桌面特有交互工具（例如 asktool），避免移动端在后台等待桌面按键
  api.on("tool_call", async (event, ctx) => {
    if (isCurrentTurnWechat && event.toolName === "asktool") {
      return {
        block: true,
        reason:
          "当前任务由微信用户远程发起，无法弹出桌面交互卡片。请直接在文本回复中列出编号选项，向微信用户提问并等待下一条微信输入。",
      };
    }
  });

  // 4. 捕获模型增量生成的完整文本（message_end）
  api.on("message_end", async (event, ctx) => {
    if (!event?.message || event.message.role !== "assistant") return;
    const text = extractText(event.message.content);
    const sessionId = ctx?.sessionId || "";

    if (text) {
      sendToMain({
        type: "assistant_chunk",
        sessionId,
        content: text,
        stopReason: event.message.stopReason,
        timestamp: Date.now(),
      });
    }
  });

  // 5. 监听回合结束或结算
  api.on("agent_end", (event, ctx) => {
    const sessionId = ctx?.sessionId || "";
    sendToMain({
      type: "agent_end",
      sessionId,
      timestamp: Date.now(),
    });
    isCurrentTurnWechat = false;
  });

  // 6. 注册向微信发送本地文件与图片的工具（AI 可主动调用，直接推送原生文件卡片到微信）
  if (typeof api.registerTool === "function") {
    api.registerTool({
      name: "send_file_to_wechat",
      description: "将当前电脑上的生成文件（如 PDF 报告、zip 包、导出的数据）作为原生文件卡片直接发送到手机微信。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "本地绝对路径或工作区相对路径",
          },
          displayName: {
            type: "string",
            description: "微信聊天中显示的文件名（可选，默认使用原文件名）",
          },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const fullPath = path.isAbsolute(args.path) ? args.path : path.resolve(process.cwd(), args.path);
        if (!fs.existsSync(fullPath)) {
          return { success: false, error: `文件不存在: ${fullPath}` };
        }
        sendToMain({
          type: "send_file",
          filePath: fullPath,
          displayName: args.displayName,
          isImage: false,
        });
        return { success: true, message: `文件已提交微信加密上传直传队列: ${path.basename(fullPath)}` };
      },
    });

    api.registerTool({
      name: "send_image_to_wechat",
      description: "将当前电脑上的生成图片或渲染截图作为原生图片直接发送到手机微信。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "本地图片文件的绝对路径或相对路径",
          },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const fullPath = path.isAbsolute(args.path) ? args.path : path.resolve(process.cwd(), args.path);
        if (!fs.existsSync(fullPath)) {
          return { success: false, error: `图片不存在: ${fullPath}` };
        }
        sendToMain({
          type: "send_file",
          filePath: fullPath,
          isImage: true,
        });
        return { success: true, message: `图片已提交微信加密直传队列: ${path.basename(fullPath)}` };
      },
    });
  }
}
