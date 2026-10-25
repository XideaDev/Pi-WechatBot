"use strict";

const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 500;
    this.code = options.code;
    this.payload = options.payload;
  }
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

const WECHAT_UIN = (() => {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
})();

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": WECHAT_UIN,
  };
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(payload?.errmsg ?? `${label} failed with HTTP ${response.status}`, {
      status: response.status,
      code: payload?.errcode,
      payload,
    });
  }

  if (typeof payload?.ret === "number" && payload.ret !== 0) {
    throw new ApiError(payload.errmsg ?? `${label} failed`, {
      status: response.status,
      code: payload.errcode ?? payload.ret,
      payload,
    });
  }

  return payload;
}

async function apiPost(baseUrl, endpoint, body, token, timeoutMs = 40_000, signal) {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
    signal: requestSignal,
  });

  return parseJsonResponse(response, endpoint);
}

async function apiGet(baseUrl, path, headers = {}) {
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  return parseJsonResponse(response, path);
}

// 1. 获取登录二维码
async function fetchQrCode(baseUrl = DEFAULT_BASE_URL) {
  return apiGet(baseUrl, "/ilink/bot/get_bot_qrcode?bot_type=3");
}

// 2. 轮询二维码扫码状态
async function getQrCodeStatus(qrcode, baseUrl = DEFAULT_BASE_URL) {
  return apiGet(
    baseUrl,
    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { "iLink-App-ClientVersion": "1" }
  );
}

// 3. 长轮询消息
async function getUpdates(baseUrl, token, cursor, signal) {
  const body = {
    get_updates_buf: cursor,
    base_info: buildBaseInfo(),
  };
  return apiPost(baseUrl, "/ilink/bot/getupdates", body, token, 40_000, signal);
}

// 4. 发送文本消息
async function sendMessage(baseUrl, token, userId, text, contextToken) {
  return apiPost(
    baseUrl,
    "/ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: userId,
        client_id: crypto.randomUUID(),
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: buildBaseInfo(),
    },
    token,
    15_000
  );
}

// 5. 打字中状态
async function sendTyping(baseUrl, token, userId, ticket, status) {
  const body = {
    ilink_user_id: userId,
    typing_ticket: ticket || "",
    status,
    base_info: buildBaseInfo(),
  };
  return apiPost(baseUrl, "/ilink/bot/sendtyping", body, token, 15_000).catch(() => {});
}

// 6. 上线与下线通知
async function notifyStart(baseUrl, token) {
  return apiPost(baseUrl, "/ilink/bot/msg/notifystart", { base_info: buildBaseInfo() }, token, 10_000).catch(() => {});
}

async function notifyStop(baseUrl, token) {
  return apiPost(baseUrl, "/ilink/bot/msg/notifystop", { base_info: buildBaseInfo() }, token, 10_000).catch(() => {});
}

module.exports = {
  DEFAULT_BASE_URL,
  ApiError,
  fetchQrCode,
  getQrCodeStatus,
  getUpdates,
  sendMessage,
  notifyStart,
  notifyStop,
  sendTyping,
};
