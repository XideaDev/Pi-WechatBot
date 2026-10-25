"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_BASE_URL, ApiError } = require("./wechat-api");

const CDN_BASE = "https://novacdn.ilink.im";
const CHANNEL_VERSION = "1.0.0";

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

/**
 * 本地 AES-128-ECB 加密文件 Buffer 并计算 MD5
 */
async function encryptFile(filePath) {
  const fileBuffer = await fs.promises.readFile(filePath);
  const rawSize = fileBuffer.length;
  const rawMd5 = crypto.createHash("md5").update(fileBuffer).digest("hex");
  const aesKey = crypto.randomBytes(16).toString("hex");
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(aesKey, "hex"), null);
  const encryptedBuffer = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
  return { rawSize, rawMd5, aesKey, encryptedBuffer };
}

/**
 * 申请腾讯 CDN 上传凭证
 */
async function getUploadUrl(baseUrl, token, params) {
  const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/getuploadurl`;
  const body = {
    filekey: params.filekey,
    media_type: params.mediaType, // 1=图片, 3=文件
    to_user_id: params.toUserId,
    rawsize: params.rawSize,
    rawfilemd5: params.rawMd5,
    filesize: params.encryptedSize,
    no_need_thumb: true,
    aeskey: params.aesKey,
    base_info: buildBaseInfo(),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await resp.json();
  const code = payload?.errcode ?? payload?.ret;
  if (typeof code === "number" && code !== 0) {
    throw new ApiError(payload.errmsg || "getuploadurl failed", { status: resp.status, code, payload });
  }
  return payload;
}

/**
 * 上传加密 Buffer 到腾讯官方 CDN
 */
async function uploadToCdn(cdnBase, uploadParam, filekey, encryptedBuffer) {
  const url = `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const resp = await fetch(url, {
    method: "POST",
    body: new Uint8Array(encryptedBuffer),
    headers: { "Content-Type": "application/octet-stream" },
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    throw new ApiError(`CDN upload failed with HTTP ${resp.status}`, { status: resp.status });
  }

  const downloadParam = resp.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload response missing x-encrypted-param header");
  }
  return downloadParam;
}

/**
 * 调用微信底层接口发送原生媒体卡片 (图片/文件)
 */
async function sendMediaMessage(baseUrl, token, userId, contextToken, itemList) {
  const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/sendmessage`;
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: userId,
      client_id: crypto.randomUUID(),
      message_type: 2, // BOT
      message_state: 2, // FINISH
      context_token: contextToken,
      item_list: itemList,
    },
    base_info: buildBaseInfo(),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await resp.json();
  const code = payload?.errcode ?? payload?.ret;
  if (typeof code === "number" && code !== 0) {
    throw new ApiError(payload.errmsg || "sendMediaMessage failed", { status: resp.status, code, payload });
  }
  return payload;
}

/**
 * 高级封装：将本地文件以原生文件卡片或图片形式发送给微信用户
 * @param {object} options { baseUrl, token, userId, contextToken, filePath, displayName, isImage }
 */
async function sendLocalFileToWechat(options) {
  const { baseUrl = DEFAULT_BASE_URL, token, userId, contextToken, filePath, displayName, isImage } = options;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Target file does not exist: ${filePath}`);
  }

  // 1. 本地 AES 加密
  const { rawSize, rawMd5, aesKey, encryptedBuffer } = await encryptFile(filePath);
  const filekey = crypto.randomBytes(16).toString("hex");
  const fileName = displayName || path.basename(filePath);
  const mediaType = isImage ? 1 : 3;

  // 2. 申请上传凭证
  const uploadResp = await getUploadUrl(baseUrl, token, {
    filekey,
    mediaType,
    toUserId: userId,
    rawSize,
    rawMd5,
    encryptedSize: encryptedBuffer.length,
    aesKey,
  });

  const uploadParam = uploadResp.upload_param || "";

  // 3. 上传到腾讯 CDN
  const downloadParam = await uploadToCdn(CDN_BASE, uploadParam, filekey, encryptedBuffer);

  // 4. 组装媒体 item 并发送
  let mediaItem = null;
  if (isImage) {
    mediaItem = {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: downloadParam,
          aes_key: aesKey,
          encrypt_type: 1,
        },
        mid_size: rawSize,
      },
    };
  } else {
    mediaItem = {
      type: 3,
      file_item: {
        file_name: fileName,
        len: String(rawSize),
        media: {
          encrypt_query_param: downloadParam,
          aes_key: aesKey,
          encrypt_type: 1,
        },
      },
    };
  }

  return await sendMediaMessage(baseUrl, token, userId, contextToken, [mediaItem]);
}

module.exports = {
  sendLocalFileToWechat,
  encryptFile,
};
