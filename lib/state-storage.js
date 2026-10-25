"use strict";

const fs = require("node:fs");
const path = require("node:path");

class StateStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.credsFile = path.join(dataDir, "credentials.json");
    this.settingsFile = path.join(dataDir, "settings.json");
    this.ensureDir();
  }

  ensureDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadCredentials() {
    try {
      if (!fs.existsSync(this.credsFile)) return null;
      const raw = fs.readFileSync(this.credsFile, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  saveCredentials(creds) {
    try {
      this.ensureDir();
      const tmp = `${this.credsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), "utf8");
      fs.renameSync(tmp, this.credsFile);
    } catch (err) {
      console.error("[WeChatAssistant] saveCredentials failed:", err);
    }
  }

  clearCredentials() {
    try {
      if (fs.existsSync(this.credsFile)) {
        fs.unlinkSync(this.credsFile);
      }
    } catch {}
  }

  loadSettings() {
    const defaults = {
      bidirectionalSync: false,
      autoAck: true,
      ackText: "已收到指令，微信 BOT 处理中…",
      targetSessionId: "auto", // "auto" 自动选最新活跃 session，或特定 sessionId
      promptPrefix: "[微信] ",
      systemRules: "当前指令来自微信端输入，请直接在正文回复，使用编号清晰陈述。如需用户确认，直接在回复中列出数字选项，避免调用阻塞式对话框。",
    };

    try {
      if (!fs.existsSync(this.settingsFile)) return defaults;
      const raw = fs.readFileSync(this.settingsFile, "utf8");
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return defaults;
    }
  }

  saveSettings(patch) {
    try {
      this.ensureDir();
      const current = this.loadSettings();
      const next = { ...current, ...patch };
      const tmp = `${this.settingsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      fs.renameSync(tmp, this.settingsFile);
      return next;
    } catch (err) {
      console.error("[WeChatAssistant] saveSettings failed:", err);
      return this.loadSettings();
    }
  }
}

module.exports = {
  StateStorage,
};
