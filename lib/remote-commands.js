"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

/**
 * 欢迎菜单与命令清单（纯净微信原生高亮排版）
 */
function getWelcomeMenu() {
  return [
    "🤖 欢迎使用 PI_WeChatBot（微信 BOT）！",
    "由 Xidea 团队出品，让您在手机微信中随时协同操控电脑端的 PI-Desktop 智能体。",
    "",
    "📌 【常用远程指令】",
    "• /sessions   查看最近活跃会话",
    "• /switch 2   切换至指定会话（例如切到第2个）",
    "• /projects   查看已登记的项目列表",
    "• /new [标题] 新建一个独立新会话",
    "• /status     查看当前微信 BOT 运行状态",
    "• /about      关于 PI_WeChatBot 与开发团队",
    "• /mute       静音当前会话，停止微信推送",
    "• /listen     开启30分钟持续镜像推送",
    "• /stop       紧急中断当前桌面任务",
    "• /help       重新查看此菜单",
    "",
    "💡 提示：无需打斜杠，直接发送一句话（如“帮我写个脚本”），微信 BOT 将自动调度电脑 AI 执行并回复给您！",
  ].join("\n");
}

/**
 * 远程命令处理器
 */
class RemoteCommandHandler {
  constructor(context) {
    this.context = context; // 传入 { client, storage, listSessions, activeWechatSessions, sessionWatcher }
  }

  /**
   * 检查是否为远程命令并执行
   * @returns {boolean} true 表示已作为命令处理，无需投递给模型；false 表示普通文本消息
   */
  async handle(text, fromUser) {
    const raw = (text || "").trim();
    if (!raw) return false;

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    // 1. 帮助 / 菜单
    if (cmd === "/help" || cmd === "/menu" || cmd === "/start" || raw === "帮助" || raw === "菜单") {
      await this.context.client.sendText(fromUser, getWelcomeMenu());
      return true;
    }

    // 2. 状态查询
    if (cmd === "/status" || raw === "状态") {
      const settings = this.context.storage.loadSettings();
      const sessions = await this.context.listSessions();
      const curId = sessions[0]?.id ? sessions[0].id.slice(0, 8) : "无";
      const isListening = this.context.activeWechatSessions.size > 0 || settings.bidirectionalSync;
      const statusText = [
        "🖥️ [PI-Desktop 微信助手状态]",
        `• 连接状态: 🟢 运行中`,
        `• 当前绑定会话: ${curId}`,
        `• 活跃会话数: ${sessions.length} 个`,
        `• 推送模式: ${settings.bidirectionalSync ? "全局双向镜像" : (isListening ? "当前单轮响应中" : "已静音")}`,
        `• 自动回执 ACK: ${settings.autoAck ? "开启" : "关闭"}`,
      ].join("\n");
      await this.context.client.sendText(fromUser, statusText);
      return true;
    }

    // 2.5 关于指令 (/about)
    if (cmd === "/about" || raw === "关于") {
      const aboutText = [
        "🤖 关于 PI_WeChatBot (微信 BOT)",
        "",
        "• 简介: 专为 PI-Desktop 打造的微信无缝协同桥梁，支持手机端下达编程任务、双向实时同步、文件互传与跨工程会话掌控。",
        "• 开发团队: Xidea",
        "• 官方网站: www.ifolo.cn",
        "• 版本号: v1.1.0",
        "",
        "感谢使用！如需指令指引，请随时回复 /help",
      ].join("\n");
      await this.context.client.sendText(fromUser, aboutText);
      return true;
    }

    // 2.8 新建会话指令 (/new [标题])
    if (cmd === "/new" || raw.startsWith("新建会话")) {
      const title = arg || "微信新会话";
      const newSessionId = crypto.randomUUID();
      const sessionsDir = path.join(os.homedir(), ".pi-desktop", "sessions");
      const newFilePath = path.join(sessionsDir, `${newSessionId}.jsonl`);

      try {
        if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(newFilePath, "", "utf8");

        // 更新绑定目标
        this.context.storage.saveSettings({ targetSessionId: newSessionId });
        this.context.activeWechatSessions.clear();
        this.context.activeWechatSessions.add(newSessionId);
        this.context.latestActiveSessionId = newSessionId;
        if (this.context.sessionWatcher) {
          this.context.sessionWatcher.trackSession(newSessionId);
        }

        await this.context.client.sendText(
          fromUser,
          `✨ 已为您在电脑上开辟全新会话！\n• 标题: ${title}\n• 会话ID: ${newSessionId.slice(0, 8)}\n• 状态: 已自动切换绑定\n\n旧会话的上下文已完全隔离，现在你可以直接在微信发送该新话题的具体任务需求。`
        );
      } catch (err) {
        await this.context.client.sendText(fromUser, `新建会话失败: ${err.message}`);
      }
      return true;
    }

    // 3. 列出所有会话
    if (cmd === "/sessions" || cmd === "/session" || cmd === "/seessions" || cmd === "/sesion" || raw === "会话列表" || raw === "会话") {
      const sessions = await this.context.listSessions();
      if (!sessions || sessions.length === 0) {
        await this.context.client.sendText(fromUser, "当前没有找到打开的项目会话，请先在电脑上打开或新建一个会话。");
        return true;
      }

      const listLines = ["📑 [最近活跃会话列表]"];
      sessions.slice(0, 6).forEach((s, idx) => {
        const sid = (s.id || s.sessionId || "").slice(0, 8);
        const title = s.title || s.name || `会话 ${sid}`;
        listLines.push(`${idx + 1}. [${sid}] ${title}`);
      });
      listLines.push("");
      listLines.push("👉 如需切换，请直接回复：/switch <序号>（例如 /switch 2）");
      await this.context.client.sendText(fromUser, listLines.join("\n"));
      return true;
    }

    // 4. 切换会话 (/switch <序号>)
    if (cmd === "/switch" || cmd === "/use") {
      const sessions = await this.context.listSessions();
      const index = parseInt(arg, 10);
      if (isNaN(index) || index < 1 || index > sessions.length) {
        await this.context.client.sendText(fromUser, `序号无效，请输入 /switch 1 ~ ${sessions.length}。可发送 /sessions 查看列表。`);
        return true;
      }

      const chosen = sessions[index - 1];
      const newSessionId = chosen.id || chosen.sessionId;
      this.context.storage.saveSettings({ targetSessionId: newSessionId });
      this.context.activeWechatSessions.clear();
      this.context.activeWechatSessions.add(newSessionId);
      this.context.latestActiveSessionId = newSessionId;
      if (this.context.sessionWatcher) {
        this.context.sessionWatcher.trackSession(newSessionId);
      }

      const title = chosen.title || chosen.name || newSessionId.slice(0, 8);
      await this.context.client.sendText(fromUser, `✅ 已成功切换微信绑定至：\n[序号 ${index}] ${title}\n后续微信指令将派发到该会话。`);
      return true;
    }

    // 5. 列出项目列表
    if (cmd === "/projects" || cmd === "/project" || raw === "项目列表" || raw === "项目") {
      const projects = getRegisteredProjects();
      if (projects.length === 0) {
        await this.context.client.sendText(fromUser, "当前尚未读取到已登记的项目。");
        return true;
      }
      const pLines = ["📁 [已登记项目列表]"];
      projects.forEach((p, idx) => {
        pLines.push(`${idx + 1}. ${p.name}\n   路径: ${p.path}`);
      });
      await this.context.client.sendText(fromUser, pLines.join("\n"));
      return true;
    }

    // 6. 静音当前推送 (/mute, /bye, /quit)
    if (cmd === "/mute" || cmd === "/bye" || cmd === "/quit" || raw === "静音") {
      this.context.activeWechatSessions.clear();
      if (this.context.sessionWatcher) {
        this.context.sessionWatcher.stop();
      }
      await this.context.client.sendText(fromUser, "🔕 已为您静音当前会话。电脑端后续的日常操作将不再推送到微信。\n如需恢复，随时直接发送问题即可再次唤醒。");
      return true;
    }

    // 7. 开启持续监听 (/listen, /unmute)
    if (cmd === "/listen" || cmd === "/unmute" || raw === "监听") {
      const sessions = await this.context.listSessions();
      const targetId = sessions[0]?.id || "";
      if (targetId) {
        this.context.activeWechatSessions.add(targetId);
        if (this.context.sessionWatcher) {
          this.context.sessionWatcher.trackSession(targetId);
        }
        await this.context.client.sendText(fromUser, `🔔 已开启对当前会话 [${targetId.slice(0, 8)}] 的持续监听（有效时长 30 分钟），电脑端生成的回复将同步推送到手机。`);
      } else {
        await this.context.client.sendText(fromUser, "未找到可用会话，请先在电脑上打开工程。");
      }
      return true;
    }

    // 8. 紧急中断任务 (/stop)
    if (cmd === "/stop" || raw === "中止" || raw === "停止") {
      // 通过桌面网关发起中止
      if (typeof pi !== "undefined" && pi.desktop?.invoke) {
        try {
          const sessions = await this.context.listSessions();
          const curId = sessions[0]?.id || "";
          if (curId) {
            await pi.desktop.invoke({
              operation: "agent/cancel",
              args: [{ sessionId: curId }],
            });
          }
        } catch {}
      }
      await this.context.client.sendText(fromUser, "🛑 已向桌面端发送中断当前任务指令。");
      return true;
    }

    return false;
  }
}

/**
 * 辅助获取登记的项目列表
 */
function getRegisteredProjects() {
  try {
    const dbPath = path.join(os.homedir(), ".pi-desktop", "pi.sqlite");
    if (!fs.existsSync(dbPath)) return [];
    // 通过简单正则扫描 sqlite 文件中的项目路径或使用默认工作区
    const cp = require("node:child_process");
    const out = cp.execSync(`sqlite3 "${dbPath}" "SELECT id, name, path FROM projects ORDER BY last_opened_at DESC LIMIT 6;"`, { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).map(line => {
      const [id, name, p] = line.split("|");
      return { id, name, path: p };
    });
  } catch {
    return [{ id: "1", name: path.basename(process.cwd()), path: process.cwd() }];
  }
}

module.exports = {
  RemoteCommandHandler,
  getWelcomeMenu,
};
