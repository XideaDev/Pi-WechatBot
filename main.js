"use strict";

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const { WeixinClient } = require("./lib/wechat-client");
const { fetchQrCode, getQrCodeStatus, DEFAULT_BASE_URL } = require("./lib/wechat-api");
const { StateStorage } = require("./lib/state-storage");
const { splitAndFilterMarkdown } = require("./lib/markdown");
const { WECHAT_SOURCE_TAG } = require("./lib/constants");
const { createQrSvg } = require("./lib/qrcode-svg");
const { SessionWatcher } = require("./lib/session-watcher");
const { RemoteCommandHandler, getWelcomeMenu } = require("./lib/remote-commands");
const { downloadAndDecryptMedia } = require("./lib/media-downloader");
const { sendLocalFileToWechat } = require("./lib/media-uploader");

const COMMAND_ID = "wechat-assistant.openPanel";
const PLUGIN_ID = "io.github.xideadev.pi-wechatbot";
const PLUGIN_DIR = __dirname;

// 优先使用 PI-Desktop 官方持久化数据目录 (~/.pi-desktop/plugins/data/<id>)
// 升级/重装/覆盖插件时该目录绝不删除，登录凭据永久保留！
function resolveDataDir() {
  const permDir = path.join(os.homedir(), ".pi-desktop", "plugins", "data", PLUGIN_ID);
  if (!fs.existsSync(permDir)) {
    try { fs.mkdirSync(permDir, { recursive: true }); } catch {}
  }
  return permDir;
}

const DATA_DIR = resolveDataDir();
const LOG_FILE = path.join(DATA_DIR, "messages.log");
let storage = null;
let client = null;
let isBridgeRunning = false;
let currentQrToken = null;
let ipcServer = null;
let ipcPort = 0;

// 会话映射：记录哪个 Session 目前由微信驱动
let activeWechatSessions = new Set();
let activeSessionTimers = new Map();
let latestActiveSessionId = "";
let sessionWatcher = null;
let pendingSafetyConfirmation = null; // { command, resolve, timer }
function appendLog(type, details) {
  try {
    // 日志滚动：超过 512KB 时重命名为 .old
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > 512 * 1024) {
        const oldFile = `${LOG_FILE}.old`;
        if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
        fs.renameSync(LOG_FILE, oldFile);
      }
    }
    const entry = {
      time: new Date().toLocaleTimeString(),
      type,
      details,
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch {}
}

function readRecentLogs(limit = 15) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n");
    return lines
      .slice(-limit)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 启动本地轻量 IPC 服务（供 agentExtension 在 Agent 进程中跨进程通信）
 */
function startIpcServer() {
  return new Promise((resolve) => {
    ipcServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = body ? JSON.parse(body) : {};
          await handleAgentEvent(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });

    ipcServer.listen(0, "127.0.0.1", () => {
      ipcPort = ipcServer.address().port;
      fs.writeFileSync(
        path.join(DATA_DIR, "ipc.json"),
        JSON.stringify({ port: ipcPort, pid: process.pid }),
        "utf8"
      );
      resolve(ipcPort);
    });
  });
}

/**
 * 处理来自 Agent 扩展进程的回调事件
 */
async function handleAgentEvent(event) {
  const { type, sessionId, content } = event;
  if (type === "send_file" && event.filePath) {
    const creds = storage ? storage.loadCredentials() : null;
    if (creds && client) {
      try {
        appendLog("文件上传", `正在将本地文件直传腾讯 CDN 并推送至微信: ${event.filePath}`);
        const targetUser = event.targetUser || creds.userId;
        const contextToken = client.getContextToken(targetUser);
        await sendLocalFileToWechat({
          baseUrl: creds.baseUrl,
          token: creds.token,
          userId: targetUser,
          contextToken,
          filePath: event.filePath,
          displayName: event.displayName,
          isImage: Boolean(event.isImage),
        });
        appendLog("文件推送成功", `文件卡片已送达微信手机端: ${event.filePath}`);
      } catch (fileErr) {
        console.error("[WeChatAssistant] send_file failed:", fileErr);
        appendLog("文件推送失败", fileErr.message);
      }
    }
  } else if (type === "assistant_chunk" && content) {
    const settings = storage ? storage.loadSettings() : {};
    const isWechatInitiated = activeWechatSessions.has(sessionId);

    if (!isWechatInitiated && !settings.bidirectionalSync) return;
    if (!client || !isBridgeRunning) return;

    appendLog("AI回复微信", `正在发送给手机微信: ${content.slice(0, 40)}...`);
    const chunks = splitAndFilterMarkdown(content);
    for (const chunk of chunks) {
      try {
        await client.sendText(null, chunk);
      } catch (err) {
        console.error("[WeChatAssistant] Failed to send assistant chunk:", err);
      }
    }
  } else if (type === "agent_start") {
    if (activeWechatSessions.has(sessionId) && client) {
      client.startTyping();
    }
  } else if (type === "agent_end" || type === "agent_settled") {
    if (client) {
      client.stopTyping();
    }
  }
}

/**
 * 列出当前可用会话（带磁盘扫描智能兜底）
 */
async function listSessions() {
  const sessions = [];

  // 1. 尝试从宿主 API 获取
  if (typeof pi !== "undefined" && pi.desktop?.invoke) {
    try {
      const res = await pi.desktop.invoke({ operation: "session/list", args: [] });
      const list = Array.isArray(res) ? res : res?.sessions;
      if (Array.isArray(list) && list.length > 0) {
        return list;
      }
    } catch {}
  }

  // 2. 本地 ~/.pi-desktop/sessions 目录兜底扫描
  try {
    const sessionsDir = path.join(os.homedir(), ".pi-desktop", "sessions");
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl") && !f.includes(".revisions."))
        .map((f) => {
          const filePath = path.join(sessionsDir, f);
          const stat = fs.statSync(filePath);
          const id = f.replace(/\.jsonl$/, "");
          return { id, sessionId: id, title: `会话 ${id.slice(0, 8)}`, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        return files.slice(0, 10);
      }
    }
  } catch {}

  return sessions;
}

/**
 * 启动微信桥接
 */
async function startBridge() {
  if (isBridgeRunning && client) return { ok: true, running: true };

  const creds = storage.loadCredentials();
  if (!creds || !creds.token) {
    return { ok: false, error: "NOT_LOGGED_IN" };
  }

  client = new WeixinClient(creds);

  client.on("message", async (msg) => {
    await onIncomingWechatMessage(msg);
  });

  client.on("session_expired", () => {
    isBridgeRunning = false;
    storage.clearCredentials();
    appendLog("状态", "微信登录已失效，请重新扫码");
    if (typeof pi !== "undefined" && pi.ui?.showToast) {
      pi.ui.showToast("微信登录凭证已过期，请重新扫码登录", "warn");
    }
  });

  client.on("poll_error", (err) => {
    appendLog("轮询错误", err.message);
  });
  // 初始化会话文件监听器（直连会话输出）
  if (!sessionWatcher) {
    sessionWatcher = new SessionWatcher();
    sessionWatcher.on("assistant_message", async ({ sessionId, text }) => {
      const settings = storage ? storage.loadSettings() : {};
      const isWechatTurn = activeWechatSessions.has(sessionId);

      // 若非微信触发且未开启双向全局镜像，不向微信推送
      if (!isWechatTurn && !settings.bidirectionalSync) return;
      if (!client || !isBridgeRunning) return;

      appendLog("推送回复", `已截获回复并推送至微信 (${text.length}字): ${text.slice(0, 30)}...`);
      const chunks = splitAndFilterMarkdown(text);
      for (const chunk of chunks) {
        try {
          await client.sendText(null, chunk);
        } catch (e) {
          console.error("[WeChatAssistant] send assistant chunk error:", e);
        }
      }

      // 单轮闭环收敛：如果未开全局镜像，回复完本轮后立即解除跟踪，电脑后续聊天不再骚扰微信
      if (!settings.bidirectionalSync) {
        activeWechatSessions.delete(sessionId);
        if (sessionWatcher) {
          sessionWatcher.untrackSession(sessionId);
        }
        appendLog("生命周期收敛", `会话 ${sessionId.slice(0, 8)} 单轮回复完毕，已自动解除监听`);
      }
    });
  }

  client.startPoll();
  isBridgeRunning = true;
  appendLog("桥接启动", `微信长轮询已启动，监听来自微信的消息`);
  return { ok: true, running: true };
}

/**
 * 停止微信桥接
 */
function stopBridge() {
  if (client) {
    client.stopPoll();
    client = null;
  }
  if (sessionWatcher) {
    sessionWatcher.stop();
    sessionWatcher = null;
  }
  isBridgeRunning = false;
  appendLog("桥接停止", "微信长轮询已暂停");
  return { ok: true, running: false };
}

/**
 * 处理从微信接收到的消息，路由到指定的 PI-Desktop 会话
 */
async function onIncomingWechatMessage(msg) {
  const settings = storage.loadSettings();
  const text = (msg.content || "").trim();
  if (!text) return;
  // 0. 安全门禁拦截确认响应
  if (pendingSafetyConfirmation && (text === "1" || text === "2")) {
    const conf = pendingSafetyConfirmation;
    clearTimeout(conf.timer);
    pendingSafetyConfirmation = null;
    if (text === "1") {
      conf.resolve({ allow: true });
      appendLog("安全门禁", `用户已在微信授权放行高危指令: ${conf.command}`);
      await client.sendText(msg.fromUser, `✅ 已授权放行指令执行：\n> ${conf.command}`);
    } else {
      conf.resolve({ allow: false });
      appendLog("安全门禁", `用户在微信拒绝了高危指令: ${conf.command}`);
      await client.sendText(msg.fromUser, `🛑 已拒绝该指令执行并保护系统安全：\n> ${conf.command}`);
    }
    return;
  }
  appendLog("收到微信消息", `${msg.fromUser || "用户"}: ${text}`);

  // 0. 优先由远程命令调度器处理快捷指令与菜单交互 (/help, /status, /sessions, /switch, /projects, /mute, /listen, /stop)
  const commandHandler = new RemoteCommandHandler({
    client,
    storage,
    listSessions,
    activeWechatSessions,
    sessionWatcher,
    latestActiveSessionId,
  });
  const isHandled = await commandHandler.handle(text, msg.fromUser);
  if (isHandled) {
    appendLog("远程命令执行", `微信端指令 [${text}] 已由本地调度器即时响应`);
    return;
  }

  // 1. 自动回复 ACK（若开启）
  if (settings.autoAck && settings.ackText) {
    client.sendText(msg.fromUser, settings.ackText).catch(() => {});
  }

  // 2. 确定目标会话
  let targetSessionId = settings.targetSessionId;
  const sessions = await listSessions();

  if (!targetSessionId || targetSessionId === "auto") {
    if (sessions.length > 0) {
      targetSessionId = sessions[0].id || sessions[0].sessionId || "";
    } else {
      targetSessionId = latestActiveSessionId;
    }
  }

  if (!targetSessionId) {
    appendLog("派发失败", "未找到活跃的 PI-Desktop 会话");
    await client.sendText(
      msg.fromUser,
      "【提示】未找到可用的 PI-Desktop 项目会话，请先在桌面上创建或打开一个项目会话。"
    );
    return;
  }

  // 记录该 Session 当前由微信单轮驱动（5分钟超时租期自动移出）
  activeWechatSessions.add(targetSessionId);
  latestActiveSessionId = targetSessionId;
  if (activeSessionTimers.has(targetSessionId)) {
    clearTimeout(activeSessionTimers.get(targetSessionId));
  }
  const timer = setTimeout(() => {
    activeWechatSessions.delete(targetSessionId);
    activeSessionTimers.delete(targetSessionId);
  }, 300_000);
  activeSessionTimers.set(targetSessionId, timer);

  // 3. 检查是否有附带图片/媒体文件，若有则自动解密下载至本地工作区
  let extraPrompt = "";
  if (msg.media && msg.media.type === "image" && msg.media.url) {
    try {
      appendLog("图片下载", "检测到微信截图，正在从腾讯 CDN 拉取并解密...");
      const targetDir = path.join(DATA_DIR, "media");
      const savedPath = await downloadAndDecryptMedia(msg.media.url, msg.media.aesKey, targetDir, ".png");
      appendLog("图片就绪", `截图已无损解密至: ${savedPath}`);
      extraPrompt = `\n\n[微信图片已就绪]\n本地绝对路径: ${savedPath}\n请调用视觉工具查看或结合上述图片进行深度分析并执行相关任务。`;
    } catch (mediaErr) {
      appendLog("图片下载失败", mediaErr.message);
      extraPrompt = `\n\n[微信图片]\n下载失败: ${mediaErr.message}`;
    }
  }

  // 4. 构造纯净 Prompt：彻底移除冗余的 [系统规则] 文本污染！
  const promptText = `${settings.promptPrefix || WECHAT_SOURCE_TAG} ${text}${extraPrompt}`;
  appendLog("任务派发", `正在将指令投递至会话 ${targetSessionId.slice(0, 8)}...`);
  if (sessionWatcher) {
    sessionWatcher.trackSession(targetSessionId);
  }
  try {
    if (typeof pi !== "undefined" && pi.desktop?.invoke) {
      await pi.desktop.invoke({
        operation: "agent/prompt",
        args: [
          {
            sessionId: targetSessionId,
            content: promptText,
          },
        ],
      });
      appendLog("派发成功", `指令已进入会话队列，等待 Agent 响应`);
    } else {
      appendLog("派发模拟", `宿主未暴露桌面网关，已记录指令`);
    }
  } catch (err) {
    console.error("[WeChatAssistant] agent/prompt failed:", err);
    appendLog("派发异常", err.message);
    await client.sendText(
      msg.fromUser,
      `【错误】发送指令到会话失败: ${err.message}`
    );
  }
}

/**
 * 面板 RPC 调度中心
 */
async function onPanelInvoke(channel, payload = {}) {
  const creds = storage.loadCredentials();
  const settings = storage.loadSettings();

  switch (channel) {
    case "wechat.getState": {
      const sessions = await listSessions();
      const logs = readRecentLogs();
      return {
        isLoggedIn: Boolean(creds && creds.token),
        isRunning: isBridgeRunning,
        userId: creds?.userId || "",
        baseUrl: creds?.baseUrl || "",
        lastSend: client?.lastSendResult || null,
        settings,
        sessions,
        logs,
      };
    }

    case "wechat.getQr": {
      const resp = await fetchQrCode();
      const token = resp.qrcode;
      const qrUrl = resp.qrcode_img_content;
      currentQrToken = token;
      const svg = createQrSvg(qrUrl);
      return {
        url: qrUrl,
        token: token,
        svg,
      };
    }

    case "wechat.pollQr": {
      const token = payload.token || currentQrToken;
      if (!token) return { status: "expired" };
      const resp = await getQrCodeStatus(token);
      if (resp.status === "confirmed" && resp.bot_token) {
        const credentials = {
          token: resp.bot_token,
          userId: resp.ilink_user_id || "",
          accountId: resp.ilink_bot_id || "",
          baseUrl: resp.baseurl || DEFAULT_BASE_URL,
        };
        storage.saveCredentials(credentials);
        appendLog("扫码登录成功", `微信账号认证成功: ${credentials.userId}`);
        await startBridge();
        // 首次扫码成功后，主动向微信端推送欢迎菜单
        setTimeout(() => {
          if (client) {
            client.sendText(credentials.userId, getWelcomeMenu()).catch(() => {});
          }
        }, 1000);
      }
      return {
        status: resp.status,
        redirectHost: resp.redirect_host,
      };
    }

    case "wechat.toggleBridge": {
      if (isBridgeRunning) {
        return stopBridge();
      } else {
        return await startBridge();
      }
    }

    case "wechat.listSessions": {
      return { sessions: await listSessions() };
    }

    case "wechat.saveSettings": {
      const next = storage.saveSettings(payload.settings || {});
      return { ok: true, settings: next };
    }

    case "wechat.logout": {
      stopBridge();
      storage.clearCredentials();
      return { ok: true, isLoggedIn: false };
    }

    default:
      throw new Error(`[WeChatAssistant] Unsupported channel: ${channel}`);
  }
}

async function onLoad() {
  storage = new StateStorage(DATA_DIR);
  await startIpcServer();

  // 注册打开面板的命令
  if (typeof pi !== "undefined" && pi.commands?.register) {
    await pi.commands.register({
      id: COMMAND_ID,
      title: "微信助手: 打开控制面板",
      keywords: ["wechat", "微信", "assistant", "bot", "助手"],
      run: async () => {
        if (pi.ui?.openPanel) {
          await pi.ui.openPanel({ title: "微信助手" });
        }
      },
    });
  }

  // 若已有保存凭据，自动启动微信长轮询
  const creds = storage.loadCredentials();
  if (creds && creds.token) {
    startBridge().catch((err) => {
      console.warn("[WeChatAssistant] Auto-start bridge failed:", err);
    });
  }
}

async function onUnload() {
  stopBridge();
  if (ipcServer) {
    ipcServer.close();
    ipcServer = null;
  }
  if (typeof pi !== "undefined" && pi.commands?.unregister) {
    try {
      await pi.commands.unregister(COMMAND_ID);
    } catch {}
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
};
