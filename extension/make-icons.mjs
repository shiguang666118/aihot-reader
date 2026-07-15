/**
 * 生成简单 PNG 图标（无需额外依赖）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "icons");
fs.mkdirSync(dir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(size) {
  // 青色圆角风格：简单纯色方块 + 中心深色
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const cx = x - size / 2;
      const cy = y - size / 2;
      const r = Math.sqrt(cx * cx + cy * cy);
      const edge = size * 0.42;
      if (r < edge) {
        raw[i] = 61;
        raw[i + 1] = 214;
        raw[i + 2] = 198;
        raw[i + 3] = 255;
      } else if (r < edge + size * 0.08) {
        raw[i] = 91;
        raw[i + 1] = 140;
        raw[i + 2] = 255;
        raw[i + 3] = 255;
      } else {
        raw[i] = 11;
        raw[i + 1] = 18;
        raw[i + 2] = 32;
        raw[i + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${s}.png`), png(s));
  console.log("wrote icon" + s + ".png");
}
