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
        lineBuffer: "",
        turnStartTime: Date.now(),
        toolCount: 0,
        modelId: "",
        usage: null,
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
      let fd = null;
      try {
        if (!fs.existsSync(state.filePath)) continue;
        const currentSize = fs.statSync(state.filePath).size;
        
        // 1. 如果文件被截断或清空重置，重置游标与残余行缓冲
        if (currentSize < state.offset) {
          state.offset = 0;
          state.lineBuffer = "";
        }
        if (currentSize <= state.offset) continue;

        const bytesToRead = currentSize - state.offset;
        const buffer = Buffer.alloc(bytesToRead);
        
        fd = fs.openSync(state.filePath, "r");
        fs.readSync(fd, buffer, 0, bytesToRead, state.offset);
        fs.closeSync(fd);
        fd = null;

        // 2. 拼接上次残留的半行（Chunked line buffer 防截断）
        const chunkText = (state.lineBuffer || "") + buffer.toString("utf8");
        const lastNewlineIdx = chunkText.lastIndexOf("\n");

        if (lastNewlineIdx === -1) {
          // 本次读取未包含完整换行，暂存并推进 offset
          state.lineBuffer = chunkText;
          state.offset = currentSize;
          continue;
        }

        const completeText = chunkText.slice(0, lastNewlineIdx);
        state.lineBuffer = chunkText.slice(lastNewlineIdx + 1);
        state.offset = currentSize;

        const lines = completeText.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            this.handleRow(sessionId, row, state);
          } catch {}
        }
      } catch (err) {
        // 文件读写冲突忽略
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch {}
        }
      }
    }
  }

  handleRow(sessionId, row, state) {
    if (!row || row.type !== "message") return;

    const msgId = String(row.id || "");
    if (msgId && state.processedIds.has(msgId)) return;
    if (msgId) state.processedIds.add(msgId);
    // 0. 如果新行是 user 消息，重置本轮执行统计
    if (row.role === "user") {
      state.turnStartTime = row.createdAt ? new Date(row.createdAt).getTime() : Date.now();
      state.toolCount = 0;
      state.modelId = "";
      state.usage = null;
      return;
    }

    // 1. 如果新行是 tool 调用执行，说明模型还在做多步工具任务，清除之前的待发送计时器
    if (row.role === "tool") {
      state.toolCount = (state.toolCount || 0) + 1;
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

      // 提取本轮模型与 Token 统计
      const meta = row.meta || {};
      if (meta.modelId) state.modelId = meta.modelId;
      if (meta.usage) state.usage = meta.usage;

      // 采用 1500ms 防抖：如果 1.5 秒内没有后续的 tool 执行，说明这是本轮最终结论！
      if (this.pendingAssistantTurns.has(sessionId)) {
        clearTimeout(this.pendingAssistantTurns.get(sessionId).timer);
      }

      const turnDurationMs = Math.max(0, Date.now() - (state.turnStartTime || Date.now()));
      const turnStats = {
        durationMs: turnDurationMs,
        toolCount: state.toolCount || 0,
        modelId: state.modelId || meta.modelId || "",
        usage: state.usage || meta.usage || null,
      };

      const timer = setTimeout(() => {
        this.pendingAssistantTurns.delete(sessionId);
        this.emit("assistant_message", {
          sessionId,
          text,
          messageId: msgId,
          stats: turnStats,
          timestamp: row.createdAt ? new Date(row.createdAt).getTime() : Date.now(),
        });
      }, 1500);

      this.pendingAssistantTurns.set(sessionId, { text, timer, stats: turnStats });
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
