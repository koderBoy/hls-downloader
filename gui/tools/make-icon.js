#!/usr/bin/env node
/**
 * 生成应用图标 build/icon.png（512×512）。
 *
 * 为什么手写 PNG 而不是找个库：这里只需要一个纯色圆角方块 + 一个白色下载箭头，
 * 用 zlib + 手搓 PNG 头就够了，不想为了一张图引入 sharp / canvas 这种重依赖。
 * electron-builder 接受 256×256 以上的 PNG，会自己转成 .ico。
 *
 * 用法:  node tools/make-icon.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

// ── 配色 ──────────────────────────────────────────────────────
const BG = [37, 99, 235];      // #2563eb 蓝
const FG = [255, 255, 255];    // 白

// ── 形状（都在 512×512 的坐标系里算）──────────────────────────
const R = 112;                 // 圆角半径

function inRoundedRect(x, y, w, h, r) {
  // 四个角各判断一次，中间区域直接通过
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

// 箭头：竖条 + 三角头
function inArrow(x, y) {
  const shaftX0 = 226, shaftX1 = 286, shaftY0 = 120, shaftY1 = 300;
  if (x >= shaftX0 && x < shaftX1 && y >= shaftY0 && y < shaftY1) return true;

  // 三角形：顶点 (256, 396)，底边 y=300，从 x=176 到 x=336
  const topY = 300, tipY = 396, halfW = 80, tipX = 256;
  if (y >= topY && y < tipY) {
    const t = (y - topY) / (tipY - topY);       // 0 → 1
    const w = halfW * (1 - t);
    return Math.abs(x - tipX) <= w;
  }
  return false;
}

// ── 渲染 ──────────────────────────────────────────────────────
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const o = (y * SIZE + x) * 4;
    const inside = inRoundedRect(x + 0.5, y + 0.5, SIZE, SIZE, R);
    if (!inside) { px[o + 3] = 0; continue; }          // 圆角外全透明
    const c = inArrow(x + 0.5, y + 0.5) ? FG : BG;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
}

// ── 打包成 PNG ────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;     // bit depth
ihdr[9] = 6;     // color type: RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// 每行前面加一个 filter 字节（0 = None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`  图标已生成: ${OUT}  (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
