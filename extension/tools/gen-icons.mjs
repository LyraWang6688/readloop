/**
 * ReadLoop 插件图标生成器（一次性工具，无第三方依赖）
 *
 * 用法：node extension/tools/gen-icons.mjs
 * 产物：extension/assets/icons/icon-{16,32,48,128}.png
 *
 * 设计：深绿圆角方块 + 米白「R」字形（ReadLoop），与 sidepanel 主题色一致。
 * 画法：4 倍超采样后用解析函数逐像素判定，再盒式降采样得到抗锯齿边缘。
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icons");
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

// 与 sidepanel 主题一致：--brand #2f6f4e / --panel #fffaf0
const BG = [47, 111, 78];
const FG = [255, 250, 240];

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 图形 ----------

/** 圆角矩形的有符号距离 */
function roundedRectDistance(x, y, left, top, width, height, radius) {
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const qx = Math.abs(x - centerX) - (width / 2 - radius);
  const qy = Math.abs(y - centerY) - (height / 2 - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 线段（带圆头）有符号距离 */
function capsuleDistance(x, y, from, to, halfWidth) {
  const vx = to[0] - from[0];
  const vy = to[1] - from[1];
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - from[0]) * vx + (y - from[1]) * vy) / lengthSquared));
  const dx = x - (from[0] + t * vx);
  const dy = y - (from[1] + t * vy);
  return Math.hypot(dx, dy) - halfWidth;
}

/** 右半环带（R 的上半部分碗形）：只取圆心右侧 */
function halfRingDistance(x, y, centerX, centerY, outerRadius, innerRadius) {
  const distance = Math.hypot(x - centerX, y - centerY);
  const midRadius = (outerRadius + innerRadius) / 2;
  const halfThickness = (outerRadius - innerRadius) / 2;
  const ringDistance = Math.abs(distance - midRadius) - halfThickness;
  // 左半边交给竖笔，避免与竖笔之间出现缝隙
  return x >= centerX ? ringDistance : Number.POSITIVE_INFINITY;
}

// R 字形参数（归一化坐标 0..1）；笔画刻意加粗，保证 16px 下仍然清晰
const STEM = { left: 0.265, top: 0.2, width: 0.17, height: 0.6, radius: 0.012 };
const BOWL = { centerX: 0.42, centerY: 0.38, outerRadius: 0.185, innerRadius: 0.06 };
const LEG = { from: [0.43, 0.49], to: [0.672, 0.72], halfWidth: 0.072 };

function glyphDistance(x, y) {
  const stemDistance = roundedRectDistance(x, y, STEM.left, STEM.top, STEM.width, STEM.height, STEM.radius);
  const bowlDistance = halfRingDistance(x, y, BOWL.centerX, BOWL.centerY, BOWL.outerRadius, BOWL.innerRadius);
  const legDistance = capsuleDistance(x, y, LEG.from, LEG.to, LEG.halfWidth);
  return Math.min(stemDistance, bowlDistance, legDistance);
}

/** 归一化像素颜色：返回 [r,g,b,a]，a 为 0 或 1（硬边，靠超采样抗锯齿） */
function sample(x, y) {
  if (roundedRectDistance(x, y, 0, 0, 1, 1, 0.22) > 0) {
    return [0, 0, 0, 0];
  }
  if (glyphDistance(x, y) <= 0) {
    return [FG[0], FG[1], FG[2], 1];
  }
  return [BG[0], BG[1], BG[2], 1];
}

function renderIcon(size) {
  const sampleSize = size * SUPERSAMPLE;
  const output = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const nx = (x * SUPERSAMPLE + sx + 0.5) / sampleSize;
          const ny = (y * SUPERSAMPLE + sy + 0.5) / sampleSize;
          const [r, g, b, a] = sample(nx, ny);
          // 预乘 alpha 累加，避免边缘出现深色描边
          red += r * a;
          green += g * a;
          blue += b * a;
          alpha += a;
        }
      }

      const offset = (y * size + x) * 4;
      const total = SUPERSAMPLE * SUPERSAMPLE;
      if (alpha > 0) {
        output[offset] = Math.round(red / alpha);
        output[offset + 1] = Math.round(green / alpha);
        output[offset + 2] = Math.round(blue / alpha);
        output[offset + 3] = Math.round((alpha / total) * 255);
      }
    }
  }

  return output;
}

// ---------- 入口 ----------

mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const filePath = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(filePath, encodePng(size, size, renderIcon(size)));
  console.log(`✅ ${filePath} (${size}×${size})`);
}
