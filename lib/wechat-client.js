"use strict";

const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  getUpdates,
  sendMessage,
  sendTyping,
  notifyStart,
  notifyStop,
  ApiError,
  DEFAULT_BASE_URL,
} = require("./wechat-api");
const { POLL_RETRY_BASE_MS, POLL_RETRY_MAX_MS } = require("./constants");

class WeixinClient extends EventEmitter {
  constructor(credentials, options = {}) {
    super();
    this.token = credentials.token;
    this.userId = credentials.userId;
    this.baseUrl = credentials.baseUrl || DEFAULT_BASE_URL;
    this.cursor = options.cursor || "";
    this.running = false;
    this.abortController = null;
    this.contextTokens = new Map(); // userId -> contextToken
    const os = require("node:os");
    const permDir = path.join(os.homedir(), ".pi-desktop", "plugins", "data", "io.github.xideadev.pi-wechatbot");
    this.tokenFilePath = path.join(permDir, "context_token.json");
    this.loadPersistedTokens();
    this.seenMessageIds = new Set();
    this.lastSendResult = null;
    this.typingTimer = null;
  }

  loadPersistedTokens() {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        const obj = JSON.parse(fs.readFileSync(this.tokenFilePath, "utf8"));
        for (const [k, v] of Object.entries(obj)) {
          this.contextTokens.set(k, v);
        }
      }
    } catch {}
  }

  setContextToken(userId, token) {
    if (userId && token) {
      this.contextTokens.set(userId, token);
      if (!this._tokenSaveTimer) {
        this._tokenSaveTimer = setTimeout(() => {
          this._tokenSaveTimer = null;
          try {
            const obj = Object.fromEntries(this.contextTokens);
            fs.writeFileSync(this.tokenFilePath, JSON.stringify(obj), "utf8");
          } catch {}
        }, 1000);
      }
    }
  }

  getContextToken(userId) {
    return this.contextTokens.get(userId) || "";
  }

  async sendText(userId, text) {
    if (!text || !text.trim()) return { success: true };
    const targetUserId = userId || this.userId;
    const contextToken = this.getContextToken(targetUserId);

    try {
      const resp = await sendMessage(this.baseUrl, this.token, targetUserId, text, contextToken);
      this.lastSendResult = {
        success: true,
        at: new Date().toISOString(),
      };
      this.emit("send_success", { userId: targetUserId, text });
      return { success: true, resp };
    } catch (err) {
      this.lastSendResult = {
        success: false,
        at: new Date().toISOString(),
        error: err.message,
        code: err.code,
      };
      this.emit("send_error", { userId: targetUserId, text, error: err });
      throw err;
    }
  }

  startTyping(userId) {
    const targetUserId = userId || this.userId;
    if (this.typingTimer) clearInterval(this.typingTimer);
    sendTyping(this.baseUrl, this.token, targetUserId, "", 1);
    this.typingTimer = setInterval(() => {
      sendTyping(this.baseUrl, this.token, targetUserId, "", 1);
    }, 4500);
  }

  stopTyping(userId) {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    const targetUserId = userId || this.userId;
    sendTyping(this.baseUrl, this.token, targetUserId, "", 2);
  }

  async startPoll() {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    // 1. 通知微信服务器该 Bot 上线
    try {
      await notifyStart(this.baseUrl, this.token);
    } catch (e) {
      console.warn("[WeChatAssistant] notifyStart failed:", e.message);
    }

    let retryDelay = POLL_RETRY_BASE_MS;

    while (this.running) {
      try {
        const resp = await getUpdates(
          this.baseUrl,
          this.token,
          this.cursor,
          this.abortController.signal
        );

        retryDelay = POLL_RETRY_BASE_MS;

        if (resp.get_updates_buf) {
          this.cursor = resp.get_updates_buf;
          this.emit("cursor_change", this.cursor);
        }

        // 微信官方返回字段为 msgs
        const rawMsgs = resp.msgs || [];
        if (Array.isArray(rawMsgs) && rawMsgs.length > 0) {
          for (const raw of rawMsgs) {
            this.handleIncomingRawMessage(raw);
          }
        }
      } catch (err) {
        if (!this.running || this.abortController?.signal.aborted) {
          break;
        }

        if (err instanceof ApiError && (err.code === 401 || err.code === -14)) {
          this.emit("session_expired", err);
          this.stopPoll();
          break;
        }

        this.emit("poll_error", err);
        await new Promise((r) => setTimeout(r, retryDelay));
        retryDelay = Math.min(retryDelay * 1.5, POLL_RETRY_MAX_MS);
      }
    }
  }

  handleIncomingRawMessage(raw) {
    // 微信消息格式：
    // raw.message_type === 1 表示用户发送给 Bot 的消息
    if (raw.message_type !== 1) return;

    const fromUser = raw.from_user_id || "";
    const msgId = String(raw.message_id || "");

    // 消息去重
    if (msgId) {
      if (this.seenMessageIds.has(msgId)) return;
      this.seenMessageIds.add(msgId);
      // FIFO 滚动去重，避免突发清空引起历史消息重放
      if (this.seenMessageIds.size > 5000) {
        const oldest = this.seenMessageIds.values().next().value;
        if (oldest) this.seenMessageIds.delete(oldest);
      }
    }

    // 记录 context_token 供后续回复
    if (raw.context_token) {
      this.setContextToken(fromUser, raw.context_token);
    }

    // 解析 item_list 提取文本与媒体
    const items = raw.item_list || [];
    const textParts = [];
    let cleanVoiceText = "";
    let isVoice = false;
    let mediaItem = null;

    for (const item of items) {
      switch (item.type) {
        case 1: { // 文本
          const text = item.text_item?.text?.trim() || "";
          if (text) textParts.push(text);
          break;
        }
        case 2: { // 图片
          const imgUrl = item.image_item?.media?.full_url || "";
          const aesKey = item.image_item?.aeskey || item.image_item?.media?.aes_key || "";
          mediaItem = { type: "image", url: imgUrl, aesKey, raw: item.image_item };
          textParts.push("[图片]");
          break;
        }
        case 3: { // 语音
          const voiceText = item.voice_item?.text?.trim() || "";
          isVoice = true;
          if (voiceText) {
            cleanVoiceText = voiceText;
            textParts.push(voiceText);
          } else {
            textParts.push("[语音消息 — 未能成功识别文字，请尝试重新语音输入或以文字发送]");
          }
          break;
        }
        case 4: { // 文件
          const fileName = item.file_item?.file_name || "文件";
          mediaItem = { type: "file", name: fileName, raw: item.file_item };
          textParts.push(`[文件: ${fileName}]`);
          break;
        }
        default:
          break;
      }
    }

    const fullText = textParts.join("\n").trim();
    if (!fullText && !mediaItem) return;

    this.emit("message", {
      messageId: msgId,
      fromUser,
      content: fullText,
      cleanVoiceText,
      isVoice,
      media: mediaItem,
      raw,
      receivedAt: Date.now(),
    });
  }

  stopPoll() {
    this.running = false;
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // 通知微信服务器下线
    notifyStop(this.baseUrl, this.token).catch(() => {});
    this.emit("stopped");
  }
}

module.exports = {
  WeixinClient,
};
