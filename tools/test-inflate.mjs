/**
 * 验收：纯 JS inflate（web/src/utils/inflateRaw.js）与 Node zlib 结果逐字节一致
 * ===========================================================================
 * 为什么需要它：这份纯 JS 解压是老 Safari（iOS < 16.4 没有 DecompressionStream）的兜底路径，
 * 一旦写错，用户看到的是"点了没反应"或"数据莫名其妙"。所以拿 zlib 当标准答案对拍：
 *   · 覆盖 stored / 固定 Huffman / 动态 Huffman 三种块（靠 deflate 的 0/1/9 级别压出来）；
 *   · 覆盖重复文本、全零、随机字节、类 XML（贴近「健康」导出）、超短数据等形状；
 *   · 末尾再跑一个 12MB 的吞吐测试，确认不会慢到把页面卡死。
 *
 * 运行：node tools/test-inflate.mjs
 * （零依赖、不写文件、不联网）
 */
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { inflateRaw } from '../web/src/utils/inflateRaw.js';

const cases = [];

// 1) 纯文本（大概率命中动态 Huffman 长码）
cases.push(['重复文本', Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(500))]);
// 2) 全零（大量长距离匹配 + 重叠复制）
cases.push(['全零 200KB', Buffer.alloc(200 * 1024)]);
// 3) 随机字节（几乎不可压缩，走 stored 块或近乎字面量）
cases.push(['随机 64KB', Buffer.from(Array.from({ length: 65536 }, () => Math.floor(Math.random() * 256)))]);
// 4) 类 XML（和「健康」导出形状接近）
const xml = ['<?xml version="1.0"?>', '<HealthData>'];
for (let i = 0; i < 4000; i += 1) {
  xml.push(` <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" value="${60 + (i % 40)}"/>`);
}
xml.push('</HealthData>');
cases.push(['类 XML', Buffer.from(xml.join('\n'))]);
// 5) 边界：1 字节 / 空
cases.push(['单字节', Buffer.from([0x42])]);
cases.push(['空数据', Buffer.alloc(0)]);
// 6) 极端重复
cases.push(['A×100KB', Buffer.from('A'.repeat(100 * 1024))]);

for (const [name, data] of cases) {
  for (const level of [0, 1, 9]) {
    const comp = zlib.deflateRawSync(data, { level });
    const mine = inflateRaw(new Uint8Array(comp), { maxOutput: 64 * 1024 * 1024 });
    assert.equal(mine.length, data.length, `${name} L${level} 长度不符`);
    assert.ok(Buffer.from(mine).equals(data), `${name} L${level} 内容不一致`);
    console.log(`  [ok] ${name} · level ${level} · ${comp.length} B → ${data.length} B`);
  }
}

// 吞吐：12MB 类 XML
const big = Buffer.from(xml.join('\n').repeat(40));
const bigComp = zlib.deflateRawSync(big, { level: 6 });
const t0 = Date.now();
const out = inflateRaw(new Uint8Array(bigComp), { maxOutput: 256 * 1024 * 1024 });
const ms = Date.now() - t0;
assert.ok(Buffer.from(out).equals(big), '大文件内容不一致');
console.log(
  `\n吞吐：${(bigComp.length / 1024 / 1024).toFixed(1)} MB 压缩 → ${(big.length / 1024 / 1024).toFixed(1)} MB，` +
    `耗时 ${ms} ms（约 ${(big.length / 1024 / 1024 / (ms / 1000)).toFixed(0)} MB/s）`,
);

console.log('\n全部通过\n');
