/**
 * 生成扩展图标 media/icon.png（128×128，VS Code 商店要求 128×128 PNG）。
 * 纯 Node 手写 PNG（zlib + CRC32），不依赖任何图像库。
 * 用法：node scratch/make_icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;

// ---- 画布 ----
const px = new Uint8Array(SIZE * SIZE * 4); // RGBA
const setPx = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // 简单 alpha 合成（源覆盖目标）
  const sa = a / 255;
  px[i] = Math.round(r * sa + px[i] * (1 - sa));
  px[i + 1] = Math.round(g * sa + px[i + 1] * (1 - sa));
  px[i + 2] = Math.round(b * sa + px[i + 2] * (1 - sa));
  px[i + 3] = Math.max(px[i + 3], a);
};

const inRoundRect = (x, y, rx0, ry0, rx1, ry1, r) => {
  if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return false;
  const cx = x < rx0 + r ? rx0 + r : x > rx1 - r ? rx1 - r : x;
  const cy = y < ry0 + r ? ry0 + r : y > ry1 - r ? ry1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 0.5;
};

const roundRect = (x0, y0, x1, y1, r, color) => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (inRoundRect(x, y, x0, y0, x1, y1, r)) setPx(x, y, color[0], color[1], color[2], color[3]);
    }
  }
};

// ---- 背景：VS Code 蓝渐变（左上深 → 右下亮）----
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const t = (x + y) / (2 * (SIZE - 1));
    const r = Math.round(0x0b + (0x1f + 0x20 - 0x0b) * t * 0.6);
    const g = Math.round(0x57 + (0x9a - 0x57) * t);
    const b = Math.round(0x8a + (0xd8 - 0x8a) * t);
    setPx(x, y, r, g, b, 255);
  }
}

// ---- 两张"对照"卡片：左英文行（浅） / 右中文行（白）----
const CARD_W = 44;
const LEFT_X = 12;
const RIGHT_X = 72;
const drawLines = (x0, color, widths) => {
  let y = 34;
  for (const w of widths) {
    roundRect(x0, y, x0 + w - 1, y + 5, 2, color);
    y += 13;
  }
};
const EN = [0xdd, 0xe8, 0xf5, 235];
const ZH = [0xff, 0xff, 0xff, 255];
roundRect(LEFT_X - 6, 24, LEFT_X + CARD_W, 100, 6, [0xff, 0xff, 0xff, 40]);
roundRect(RIGHT_X - 6, 24, RIGHT_X + CARD_W, 100, 6, [0xff, 0xff, 0xff, 40]);
drawLines(LEFT_X, EN, [30, 40, 22, 38, 26]);
drawLines(RIGHT_X, ZH, [40, 26, 34, 30, 18]);

// ---- 中间的双向箭头（划词联动的意象）----
const ARROW = [0xff, 0xd1, 0x66, 255];
const midY = 62;
roundRect(58, midY - 1, 69, midY + 1, 1, ARROW);
for (let i = 0; i < 4; i++) {
  setPx(56 + i, midY - i, ARROW[0], ARROW[1], ARROW[2], ARROW[3]);
  setPx(56 + i, midY + i, ARROW[0], ARROW[1], ARROW[2], ARROW[3]);
  setPx(71 - i, midY - i, ARROW[0], ARROW[1], ARROW[2], ARROW[3]);
  setPx(71 - i, midY + i, ARROW[0], ARROW[1], ARROW[2], ARROW[3]);
}

// ---- 编码 PNG ----
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`已生成 ${out}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`);
