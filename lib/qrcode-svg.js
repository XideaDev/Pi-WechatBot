"use strict";

const QRCode = require("./qrcode/index");
const QRErrorCorrectLevel = require("./qrcode/QRErrorCorrectLevel");

/**
 * 将文本转为纯 SVG 矢量图代码
 */
function createQrSvg(text, options = {}) {
  const size = options.size || 220;
  const margin = options.margin || 2;
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const totalCells = count + margin * 2;
  const cellSize = size / totalCells;

  let rects = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        const x = (col + margin) * cellSize;
        const y = (row + margin) * cellSize;
        rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="currentColor" />`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%"><rect width="${size}" height="${size}" fill="white" /><g color="#111111">${rects}</g></svg>`;
}

module.exports = {
  createQrSvg,
};
