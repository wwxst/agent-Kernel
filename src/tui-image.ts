/**
 * 本地 PNG 预览：由真实 read 工具获准读取的图像字节生成终端文字缩略图。
 *
 * Kitty / Sixel / iTerm2 图形协议各有不同的窗口与重绘语义；这层使用 PNG
 * 解码后的亮度网格作为跨 Windows Terminal / conhost 的无依赖兜底。
 * 不读取文件、不修改模型 ToolResult，也绝不把原始二进制塞进 Transcript。
 */
import { inflateSync } from "node:zlib";

export interface ImagePreview {
  format: "PNG" | "JPEG" | "GIF" | "WebP";
  width?: number;
  height?: number;
  /** PNG 可提供真实像素缩略图；其他格式显示明确的降级说明。 */
  rows: string[];
}

const MAX_PIXELS = 2_000_000;
const MAX_RAW_BYTES = 12_000_000;
const PALETTE = " .:-=+*#%@";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function samplePixel(row: Buffer, x: number, colorType: number, palette: Buffer): number {
  if (colorType === 0 || colorType === 4) return row[x * (colorType === 0 ? 1 : 2)]!;
  if (colorType === 3) {
    const at = (row[x] ?? 0) * 3;
    if (at + 2 >= palette.length) return 0;
    return Math.round((palette[at]! * 299 + palette[at + 1]! * 587 + palette[at + 2]! * 114) / 1000);
  }
  const at = x * (colorType === 2 ? 3 : 4);
  return Math.round(((row[at] ?? 0) * 299 + (row[at + 1] ?? 0) * 587 + (row[at + 2] ?? 0) * 114) / 1000);
}

function paeth(a: number, b: number, c: number): number {
  const prediction = a + b - c;
  const left = Math.abs(prediction - a);
  const above = Math.abs(prediction - b);
  const upper = Math.abs(prediction - c);
  return left <= above && left <= upper ? a : above <= upper ? b : c;
}

function decodePng(bytes: Buffer): ImagePreview | undefined {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bpp = 0;
  let colorType = -1;
  let valid = false;
  let palette: Buffer = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length || length > MAX_RAW_BYTES) return undefined;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    const value = bytes.subarray(offset + 8, offset + 8 + length);
    if (kind === "IHDR") {
      if (length !== 13) return undefined;
      width = value.readUInt32BE(0);
      height = value.readUInt32BE(4);
      const depth = value[8];
      colorType = value[9]!;
      bpp = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
      if (depth !== 8 || bpp === 0 || value[12] !== 0 ||
          width === 0 || height === 0 || width * height > MAX_PIXELS) return undefined;
    } else if (kind === "PLTE") {
      palette = value;
    } else if (kind === "IDAT") {
      chunks.push(value);
    } else if (kind === "IEND") {
      valid = true;
      break;
    }
    offset = end;
  }
  if (!valid || chunks.length === 0 || width <= 0 || height <= 0) return undefined;
  const stride = width * bpp;
  if ((stride + 1) * height > MAX_RAW_BYTES) return undefined;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: MAX_RAW_BYTES }); }
  catch { return undefined; }
  if (raw.length !== (stride + 1) * height) return undefined;

  const targetWidth = Math.min(32, width);
  const targetHeight = Math.min(14, Math.max(1, Math.round(height / width * targetWidth / 2)));
  const samples: number[][] = Array.from({ length: targetHeight }, () => new Array<number>(targetWidth).fill(0));
  const counts: number[][] = Array.from({ length: targetHeight }, () => new Array<number>(targetWidth).fill(0));
  let above = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position++]!;
    if (filter > 4) return undefined;
    const current = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? current[x - bpp]! : 0;
      const top = above[x]!;
      const upper = x >= bpp ? above[x - bpp]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? top
        : filter === 3 ? Math.floor((left + top) / 2) : paeth(left, top, upper);
      current[x] = (current[x]! + predictor) & 255;
    }
    const targetY = Math.min(targetHeight - 1, Math.floor(y * targetHeight / height));
    for (let x = 0; x < width; x++) {
      const targetX = Math.min(targetWidth - 1, Math.floor(x * targetWidth / width));
      samples[targetY]![targetX]! += samplePixel(current, x, colorType, palette);
      counts[targetY]![targetX]!++;
    }
    above = current;
  }
  const rows = samples.map((line, y) => line.map((sum, x) => {
    const value = sum / Math.max(1, counts[y]![x]!);
    return PALETTE[Math.min(PALETTE.length - 1, Math.floor(value / 256 * PALETTE.length))]!;
  }).join(""));
  return { format: "PNG", width, height, rows };
}

/** 文件签名而非扩展名决定实际格式；不可信或超大图像直接明确拒绝预览。 */
export function previewImage(bytes: Buffer): ImagePreview | undefined {
  if (bytes.length < 12 || bytes.length > 4_000_000) return undefined;
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { format: "JPEG", rows: [] };
  if (bytes.toString("ascii", 0, 6) === "GIF89a" || bytes.toString("ascii", 0, 6) === "GIF87a") {
    return { format: "GIF", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), rows: [] };
  }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { format: "WebP", rows: [] };
  }
  return undefined;
}
