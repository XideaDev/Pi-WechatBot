"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 下载并解密微信官方 CDN 媒体文件 (AES-128-ECB)
 * @param {string} url 腾讯 CDN 下载地址 (image_item.media.full_url)
 * @param {string} aesKeyHex 32 位十六进制 AES 解密密钥 (image_item.aeskey)
 * @param {string} targetDir 本地目标保存目录
 * @param {string} defaultExt 默认后缀名 (如 .png, .jpg)
 * @returns {Promise<string>} 返回解密后的本地绝对文件路径
 */
async function downloadAndDecryptMedia(url, aesKeyHex, targetDir, defaultExt = ".png") {
  if (!url) throw new Error("Missing media download URL");

  // 1. 创建保存目录 (按日期分目录：.pi-wechat-files/images/YYYYMMDD/)
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const saveDir = path.join(targetDir, "images", dateStr);
  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
  }

  // 2. 确定本地文件名
  const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 16);
  const targetFile = path.join(saveDir, `wechat_${Date.now().toString(36)}_${hash}${defaultExt}`);

  // 3. 原生 fetch 下载加密 Buffer
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to download media from CDN: HTTP ${response.status}`);
  }

  const encryptedBuffer = Buffer.from(await response.arrayBuffer());

  // 4. 若无 AES Key 或已明文，直接写入
  if (!aesKeyHex) {
    fs.writeFileSync(targetFile, encryptedBuffer);
    return targetFile;
  }

  // 5. 核心 AES-128-ECB 解密 (自适应 Hex 或 Base64 格式，确保 16 字节 Key)
  let key;
  if (typeof aesKeyHex === "string" && aesKeyHex.length === 32 && /^[0-9a-fA-F]+$/.test(aesKeyHex)) {
    key = Buffer.from(aesKeyHex, "hex");
  } else if (typeof aesKeyHex === "string") {
    key = Buffer.from(aesKeyHex, "base64");
  } else {
    key = Buffer.from(aesKeyHex);
  }
  if (key.length !== 16) {
    throw new Error(`Invalid AES key length: expected 16 bytes, got ${key.length}`);
  }
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  const decryptedBuffer = Buffer.concat([
    decipher.update(encryptedBuffer),
    decipher.final(),
  ]);

  fs.writeFileSync(targetFile, decryptedBuffer);
  return targetFile;
}

module.exports = {
  downloadAndDecryptMedia,
};
