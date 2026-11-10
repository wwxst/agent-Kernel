/**
 * 图片预览基于实际 PNG 字节生成，输出为有界终端字符，不生成假缩略图。
 * 不依赖系统图片查看器、外部 shell 或网络。
 */
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { previewImage } from "../src/tui-image.ts";
import { Workspace } from "../src/workspace.ts";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function png(width = 16, height = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit grayscale
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.from(Array.from({ length: width }, (_, x) => x < width / 2 ? 0 : 255));
    rows.push(Buffer.concat([Buffer.from([0]), row])); // PNG filter None
  }
  return Buffer.concat([signature, chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("真实 PNG：解码像素和尺寸，缩略图左暗右亮且字符数受限", () => {
  const preview = previewImage(png());
  assert.equal(preview?.format, "PNG");
  assert.equal(preview?.width, 16);
  assert.equal(preview?.height, 8);
  assert.ok(preview.rows.length > 0 && preview.rows.length <= 14);
  assert.equal(preview.rows[0].length, 16);
  assert.notEqual(preview.rows[0][0], preview.rows[0][15]);
  assert.ok(preview.rows.every((line) => line.length <= 32));
});

test("PNG 透明像素：RGBA 透明黑色与真实不透明黑色的终端亮度不同", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const scanline = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 255]);
  const bytes = Buffer.concat([signature, chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanline)), chunk("IEND", Buffer.alloc(0))]);
  const image = previewImage(bytes);
  assert.equal(image?.format, "PNG");
  assert.equal(image?.rows[0].length, 2);
  assert.equal(image.rows[0][0], "@", "透明像素合成到白色背景");
  assert.equal(image.rows[0][1], " ", "真实黑色像素应保持暗色");
});

test("PNG tRNS：8-bit 灰度透明色以大端 16-bit 样本匹配，其他灰度不透明", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // 灰度
  const transparentGray = Buffer.from([0, 0]); // 8-bit 灰度值 0 的 tRNS
  const scanline = Buffer.from([0, 0, 1]); // 左透明黑色，右不透明近黑色
  const bytes = Buffer.concat([signature, chunk("IHDR", ihdr), chunk("tRNS", transparentGray),
    chunk("IDAT", deflateSync(scanline)), chunk("IEND", Buffer.alloc(0))]);
  const image = previewImage(bytes);
  assert.equal(image?.format, "PNG");
  assert.equal(image.rows[0][0], "@", "tRNS 灰度透明像素应合成白色背景");
  assert.equal(image.rows[0][1], " ", "未匹配 tRNS 的灰度必须保持不透明");
});

test("PNG tRNS：RGB 必须三通道全匹配才透明", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const transparentBlack = Buffer.alloc(6); // R=G=B=0，每个样本 16-bit big-endian
  const scanline = Buffer.from([0, 0, 0, 0, 0, 0, 1]);
  const bytes = Buffer.concat([signature, chunk("IHDR", ihdr), chunk("tRNS", transparentBlack),
    chunk("IDAT", deflateSync(scanline)), chunk("IEND", Buffer.alloc(0))]);
  const image = previewImage(bytes);
  assert.equal(image?.format, "PNG");
  assert.equal(image.rows[0][0], "@", "完全匹配 tRNS 的黑色应透明");
  assert.equal(image.rows[0][1], " ", "只改变蓝通道不能误判为透明");
});

test("PNG tRNS：错误长度不能被解释成部分透明色", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const bytes = Buffer.concat([signature, chunk("IHDR", ihdr), chunk("tRNS", Buffer.from([0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
  const image = previewImage(bytes);
  assert.equal(image, undefined, "tRNS Chunk 格式无效时不得冒充经过校验的 PNG");
});

test("不支持的 PNG 像素深度明确降级为格式尺寸，不伪造文字缩略图", () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 16; // valid 16-bit grayscale PNG，当前终端灰度转换不解码
  const bytes = Buffer.concat([signature, chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual(previewImage(bytes), { format: "PNG", width: 1, height: 1, rows: [] });
});

test("PNG CRC：损坏的 IHDR、IDAT、辅助 Chunk 都不能进入像素或元数据预览", () => {
  const valid = png();
  for (const [label, offset] of [
    ["IHDR", 20],
    ["IDAT", 41],
  ]) {
    const bad = Buffer.from(valid);
    bad[offset] ^= 1;
    assert.equal(previewImage(bad), undefined, label + " 的 CRC 错误不能降级成已确认 PNG");
  }
  const withText = Buffer.concat([signature,
    valid.subarray(8, 33), chunk("tEXt", Buffer.from("key\0value")),
    valid.subarray(33)]);
  assert.ok(previewImage(withText)?.rows.length > 0, "CRC 正确的辅助 Chunk 可以安全跳过");
  const badText = Buffer.from(withText);
  badText[33 + 8 + 1] ^= 1; // tEXt 数据损坏但旧 CRC 不变
  assert.equal(previewImage(badText), undefined, "辅助 Chunk 的 CRC 也必须检查");
});

test("PNG Chunk：缺少 IEND、尾随字节、错误顺序和重复头均安全拒绝", () => {
  const valid = png();
  const hdr = valid.subarray(8, 33);
  const imageData = valid.subarray(33, valid.length - 12);
  const end = chunk("IEND", Buffer.alloc(0));
  const invalid = [
    valid.subarray(0, valid.length - 12),
    Buffer.concat([valid, Buffer.from("junk")]),
    Buffer.concat([signature, imageData, hdr, end]),
    Buffer.concat([signature, hdr, hdr, imageData, end]),
    Buffer.concat([signature, hdr, end, imageData]),
    Buffer.concat([signature, hdr, chunk("CSTM", Buffer.from([1])), imageData, end]),
    Buffer.concat([signature, hdr, imageData, chunk("tEXt", Buffer.from("key\0data")), imageData, end]),
  ];
  for (const bytes of invalid) {
    assert.equal(previewImage(bytes), undefined, "无效的 PNG Chunk 不得显示图片或格式已确认");
  }
});

test("PNG Chunk：连续 IDAT、有效辅助 Chunk 和受支持格式仍能真正解码", () => {
  const valid = png();
  const hdr = valid.subarray(8, 33);
  const originalLength = valid.readUInt32BE(33);
  const raw = valid.subarray(41, 41 + originalLength);
  const middle = Math.max(1, Math.floor(raw.length / 2));
  const split = Buffer.concat([signature, hdr,
    chunk("tEXt", Buffer.from("description\0example")),
    chunk("IDAT", raw.subarray(0, middle)), chunk("IDAT", raw.subarray(middle)),
    chunk("IEND", Buffer.alloc(0))]);
  const result = previewImage(split);
  assert.equal(result?.format, "PNG");
  assert.ok(result.rows.length > 0, "合法连续 IDAT 仍产生真实缩略图");
  assert.equal(result.width, 16);
});

test("图片文件安全：无效或过大输入不会生成虚假预览", () => {
  assert.equal(previewImage(Buffer.from("not an image")), undefined);
  assert.equal(previewImage(png().subarray(0, 32)), undefined);
  assert.equal(previewImage(Buffer.alloc(4_000_001)), undefined);
  const gif = Buffer.from("GIF89a\x02\x00\x03\x00" + "x".repeat(10), "binary");
  assert.deepEqual(previewImage(gif), { format: "GIF", width: 2, height: 3, rows: [] });
});

test("获准执行的 Workspace.read 才传送真实 PNG 字节给 TUI 观察者", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-image-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = png();
  await writeFile(path.join(root, "screenshot.png"), bytes);
  const read = [];
  const workspace = new Workspace({ root,
    onImageRead: (requested, actual) => read.push({ requested, actual }),
  });
  const result = await workspace.read("screenshot.png");
  assert.equal(typeof result, "string", "工具返回语义保持原样");
  assert.equal(read.length, 1);
  assert.equal(read[0].requested, "screenshot.png");
  assert.ok(read[0].actual.equals(bytes));
  assert.equal(previewImage(read[0].actual)?.rows.length > 0, true);
});
