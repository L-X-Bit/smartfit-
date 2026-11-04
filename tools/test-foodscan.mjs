/**
 * 拍照识热量接口验收脚本（可对本地也可对线上跑）
 * ===========================================================================
 * 用途：交接报告里「BUG-1 JPEG/纯色图 500」的回归标准。把这份脚本对着任意环境跑一遍，
 *      就能确认该接口对所有常见输入都不再 500、且在 15s 内返回。
 *
 * 用法：
 *   node tools/test-foodscan.mjs                        # 默认打本地 http://127.0.0.1:3000
 *   APP_URL=https://smartfit-qsyh.onrender.com node tools/test-foodscan.mjs   # 打线上（部署后复测用）
 *
 * 判定标准（对应报告第四章验收清单 1~3 条）：
 *   · 任何一张图都不得返回 500；
 *   · 纯色 / 极小图 / 损坏图 → 返回 200，且 data.notFood / data.degraded 为 true；
 *   · 单次耗时 < 15s。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = process.env.APP_URL || 'http://127.0.0.1:3000';
const USER = process.env.DEMO_USER || 'demo';
const PASS = process.env.DEMO_PASS || '123456';
const MAX_MS = Number(process.env.MAX_MS || 15000);

// ---------------- PNG 生成（纯 node，无第三方依赖）----------------
const crcTable = [];
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function png(w, h, fn) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = fn(x, y, w, h);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const shotDir = path.join(ROOT, 'docs', 'screenshots');
const shotName = fs.existsSync(shotDir) ? fs.readdirSync(shotDir).find((f) => f.endsWith('.png')) : null;

const CASES = [
  { name: '纯色 PNG 64×64', mime: 'image/png', buf: png(64, 64, () => [200, 40, 40]), expectDegrade: true },
  { name: '渐变 PNG 320×240', mime: 'image/png', buf: png(320, 240, (x, y, w, h) => [Math.round(250 - 40 * (y / h)), Math.round(206 - 80 * (x / w)), 150]), expectDegrade: false },
  { name: '噪声 PNG 800×600', mime: 'image/png', buf: png(800, 600, () => [Math.random() * 255 | 0, Math.random() * 255 | 0, Math.random() * 255 | 0]), expectDegrade: false },
  { name: 'GIF 1×1', mime: 'image/gif', buf: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), expectDegrade: true },
  {
    name: '伪 JPEG（字节损坏）',
    mime: 'image/jpeg',
    buf: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20 * 1024, 3)]),
    expectDegrade: true,
  },
];
if (shotName) CASES.push({ name: '真实截图 PNG', mime: 'image/png', buf: fs.readFileSync(path.join(shotDir, shotName)), expectDegrade: false });

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const loginBody = await loginRes.json().catch(() => ({}));
if (!loginBody?.data?.token) {
  console.error(`❌ 登录失败（${BASE}）：${loginBody?.message || loginRes.status}`);
  process.exit(1);
}
const token = loginBody.data.token;

console.log(`目标环境：${BASE}\n`);
let failed = 0;
for (const c of CASES) {
  const t0 = Date.now();
  let status = 0;
  let body = {};
  try {
    const res = await fetch(`${BASE}/api/food-scan/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ imageDataUrl: `data:${c.mime};base64,${c.buf.toString('base64')}` }),
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (err) {
    console.log(`  ☠️  ${c.name.padEnd(18)} 请求失败：${err.message}`);
    failed += 1;
    continue;
  }
  const ms = Date.now() - t0;
  const isDegraded = Boolean(body?.data?.degraded);
  const isNotFood = Boolean(body?.data?.notFood);
  const problems = [];
  if (status === 500) problems.push('出现 500');
  if (status !== 200) problems.push(`HTTP ${status}（期望 200 或明确 4xx）`);
  if (ms > MAX_MS) problems.push(`耗时 ${ms}ms 超过 ${MAX_MS}ms`);
  if (c.expectDegrade && status === 200 && !isDegraded && !isNotFood) problems.push('未给出降级/非食物标记');
  const verdict = problems.length ? `❌ ${problems.join('；')}` : '✅';
  console.log(`  ${verdict} ${c.name.padEnd(18)} HTTP ${status} ${String(ms).padStart(5)}ms ${(c.buf.length / 1024).toFixed(0).padStart(5)}KB  ${String(body.message || '').slice(0, 52)}`);
  if (problems.length) failed += 1;
}

console.log(`\n===== ${CASES.length - failed} / ${CASES.length} 项通过${failed ? `，${failed} 项异常` : '，全部正常'} =====`);
process.exit(failed ? 1 : 0);
