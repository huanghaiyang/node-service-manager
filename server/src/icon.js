/**
 * 纯 JS 生成多尺寸 .ico —— 托盘图标与浏览器 favicon 共用。
 *
 * 为什么自己写：托盘（NotifyIcon）只认 .ico 这类位图，而项目里
 * 没有任何图像依赖（也不想引入 native/canvas）。整个项目坚持「零原生依赖」，
 * 所以这里直接按 ICO 规范拼字节：ICONDIR + 若干 ICONDIRENTRY + 每个尺寸一段 BMP(DIB) 数据。
 *
 * 图形与顶栏 logo / favicon.svg 保持同一套视觉：蓝紫渐变圆角方块 + 白色齿轮。
 * 用 4× 超采样后做盒式平均，边缘不会有锯齿。
 */

const BG_TOP = [79, 156, 249];   // #4f9cf9
const BG_BOTTOM = [169, 123, 245]; // #a97bf5
const GEAR = [255, 255, 255];

const CORNER = 0.24;   // 圆角半径（相对边长）
const R_DISK = 0.30;   // 齿轮盘半径
const R_TEETH = 0.405; // 齿顶半径
const R_HOLE = 0.105;  // 中心孔
const TEETH = 8;
const TOOTH_HALF = 0.26; // 齿宽（占单个扇区的一半比例）

const lerp = (a, b, t) => a + (b - a) * t;

/** 圆角方块的内部判定 */
function insideRoundedSquare(u, v, r = CORNER) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 采样一个点（u,v ∈ [0,1]），返回 [r,g,b,a]。
 * 纯函数，便于单测直接验证形状。
 */
export function samplePixel(u, v) {
  if (!insideRoundedSquare(u, v)) return [0, 0, 0, 0];

  const dx = u - 0.5;
  const dy = v - 0.5;
  const dist = Math.hypot(dx, dy);

  const ang = Math.atan2(dy, dx);
  const sector = (2 * Math.PI) / TEETH;
  const phase = ((ang % sector) + sector) % sector;
  const inTooth = Math.abs(phase - sector / 2) <= sector * TOOTH_HALF;

  let isGear = dist <= R_DISK || (inTooth && dist <= R_TEETH);
  if (dist < R_HOLE) isGear = false; // 中心镂空

  if (isGear) return [GEAR[0], GEAR[1], GEAR[2], 255];

  const t = v;
  return [
    Math.round(lerp(BG_TOP[0], BG_BOTTOM[0], t)),
    Math.round(lerp(BG_TOP[1], BG_BOTTOM[1], t)),
    Math.round(lerp(BG_TOP[2], BG_BOTTOM[2], t)),
    255,
  ];
}

/** 生成单尺寸的 RGBA 像素（size × size，高分辨率后平均下来） */
export function renderPixels(size, { supersample = 4 } = {}) {
  const ss = supersample;
  const out = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const px = samplePixel(u, v);
          // 预乘 alpha 再做平均，避免边缘发黑
          const alpha = px[3] / 255;
          r += px[0] * alpha;
          g += px[1] * alpha;
          b += px[2] * alpha;
          a += px[3];
        }
      }
      const meanA = a / n;
      const k = meanA > 0 ? 255 / (meanA * n) : 0; // 还原未预乘颜色
      const i = (y * size + x) * 4;
      out[i] = Math.min(255, Math.round(r * k));
      out[i + 1] = Math.min(255, Math.round(g * k));
      out[i + 2] = Math.min(255, Math.round(b * k));
      out[i + 3] = Math.round(meanA);
    }
  }
  return out;
}

/**
 * 把 RGBA 像素打成 ICO 里的 BMP(DIB) 段：
 * BITMAPINFOHEADER + 自下而上的 BGRA + 全零 AND 掩码（32 位图靠 alpha 通道）。
 */
export function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // biSize
  header.writeInt32LE(size, 4);         // biWidth
  header.writeInt32LE(size * 2, 8);     // biHeight = XOR + AND
  header.writeUInt16LE(1, 12);          // biPlanes
  header.writeUInt16LE(32, 14);         // biBitCount
  header.writeUInt32LE(0, 16);          // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = size - 1 - y; // BMP 自下而上
    for (let x = 0; x < size; x += 1) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];     // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s];     // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size); // 全 0 = 全不透明
  return Buffer.concat([header, xor, mask]);
}

/**
 * 生成完整 .ico
 * @param {{ sizes?: number[], supersample?: number }} opts
 * @returns {Buffer}
 */
export function buildIco({ sizes = [16, 24, 32, 48], supersample = 4 } = {}) {
  const images = sizes.map((size) => {
    const dib = encodeDib(renderPixels(size, { supersample }), size);
    return { size, dib };
  });

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);           // reserved
  dir.writeUInt16LE(1, 2);           // type = icon
  dir.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  images.forEach((img, i) => {
    const base = i * 16;
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, base);      // width
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, base + 1);  // height
    entries.writeUInt8(0, base + 2);   // colorCount
    entries.writeUInt8(0, base + 3);   // reserved
    entries.writeUInt16LE(1, base + 4);  // planes
    entries.writeUInt16LE(32, base + 6); // bitCount
    entries.writeUInt32LE(img.dib.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += img.dib.length;
  });

  return Buffer.concat([dir, entries, ...images.map((i) => i.dib)]);
}
