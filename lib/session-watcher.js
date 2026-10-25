"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const EventEmitter = require("node:events");

/**
 * 监听 PI-Desktop 会话文件 (~/.pi-desktop/sessions/<id>.jsonl) 的实时输出
 * 具备 Agent 工具调用感知能力：防止中间工具碎语被误判为最终回复，确保将最终结论推送到微信
 */
class SessionWatcher extends EventEmitter {
  constructor() {
    super();
    this.sessionsDir = path.join(os.homedir(), ".pi-desktop", "sessions");
    this.tracked = new Map(); // sessionId -> { filePath, offset, processedIds: Set }
    this.pendingAssistantTurns = new Map(); // sessionId -> { text, timer }
    this.timer = null;
  }

  trackSession(sessionId) {
    if (!sessionId) return;
    const filePath = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    if (!this.tracked.has(sessionId)) {
      let initialOffset = 0;
      try {
        if (fs.existsSync(filePath)) {
          initialOffset = fs.statSync(filePath).size;
        }
      } catch {}
      this.tracked.set(sessionId, {
        filePath,
        offset: initialOffset,
        processedIds: new Set(),
      });
    }

    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), 400);
    }
  }

  untrackSession(sessionId) {
    if (this.pendingAssistantTurns.has(sessionId)) {
      clearTimeout(this.pendingAssistantTurns.get(sessionId).timer);
      this.pendingAssistantTurns.delete(sessionId);
    }
    if (this.tracked.has(sessionId)) {
      this.tracked.delete(sessionId);
    }
    if (this.tracked.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll() {
    for (const [sessionId, state] of this.tracked.entries()) {
      try {
        if (!fs.existsSync(state.filePath)) continue;
        const currentSize = fs.statSync(state.filePath).size;
        if (currentSize <= state.offset) continue;

        const buffer = Buffer.alloc(currentSize - state.offset);
        const fd = fs.openSync(state.filePath, "r");
        fs.readSync(fd, buffer, 0, buffer.length, state.offset);
        fs.closeSync(fd);
        state.offset = currentSize;

        const chunkText = buffer.toString("utf8");
        const lines = chunkText.split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            this.handleRow(sessionId, row, state);
          } catch {}
        }
      } catch (err) {
        // 文件读写冲突忽略
      }
    }
  }

  handleRow(sessionId, row, state) {
    if (!row || row.type !== "message") return;

    const msgId = String(row.id || "");
    if (msgId && state.processedIds.has(msgId)) return;
    if (msgId) state.processedIds.add(msgId);

    // 1. 如果新行是 tool 调用执行，说明模型还在做多步工具任务，清除之前的待发送计时器
    if (row.role === "tool") {
      if (this.pendingAssistantTurns.has(sessionId)) {
        clearTimeout(this.pendingAssistantTurns.get(sessionId).timer);
        this.pendingAssistantTurns.delete(sessionId);
      }
      return;
    }

    // 2. 如果是 assistant 回复
    if (row.role === "assistant") {
      let text = "";
      if (Array.isArray(row.blocks)) {
        text = row.blocks
          .map((b) => (typeof b === "string" ? b : b?.text || ""))
          .join("")
          .trim();
      } else if (typeof row.content === "string") {
        text = row.content.trim();
      }

      if (!text) return;

      // 检查当前 assistant 块是否只是简单的工具前置碎语（例如含有工具名或说明）
      // 采用 1500ms 防抖：如果 1.5 秒内没有后续的 tool 执行，说明这是本轮最终结论！
      if (this.pendingAssistantTurns.has(sessionId)) {
        clearTimeout(this.pendingAssistantTurns.get(sessionId).timer);
      }

      const timer = setTimeout(() => {
        this.pendingAssistantTurns.delete(sessionId);
        this.emit("assistant_message", {
          sessionId,
          text,
          messageId: msgId,
          timestamp: row.createdAt ? new Date(row.createdAt).getTime() : Date.now(),
        });
      }, 1500);

      this.pendingAssistantTurns.set(sessionId, { text, timer });
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const item of this.pendingAssistantTurns.values()) {
      clearTimeout(item.timer);
    }
    this.pendingAssistantTurns.clear();
    this.tracked.clear();
  }
}

module.exports = {
  SessionWatcher,
};
