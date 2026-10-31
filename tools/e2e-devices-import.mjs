/**
 * 验收（真浏览器）：设备同步页「选择文件导入「健康」导出 zip」整条链路
 * ===========================================================================
 * 为什么有了单测还要这个：
 *   `tools/test-apple-health-browser.mjs` 只证明了「解析函数」对，证明不了**页面上真的能选、能出预览**——
 *   而线上问题恰恰出在页面这一层（accept 过滤、旧版本没部署、按钮没绑事件……）。
 *   这里用 Edge/Chrome 的 CDP 无头模式真点一遍：登录 → 进设备同步 → 把示例 zip 塞进 file input
 *   → 等页面自己解析 + 预览 → 截图存档。
 *
 * 运行：
 *   node tools/e2e-devices-import.mjs                        # 默认打 http://127.0.0.1:3000，用自动生成的示例包
 *   node tools/e2e-devices-import.mjs https://xxx.onrender.com
 *   node tools/e2e-devices-import.mjs https://xxx.onrender.com "D:\\我的导出.zip"   # 用真实导出验收
 *
 * 依赖：本机装了 Edge 或 Chrome（自动探测，也可用 EDGE_PATH / CHROME_PATH 指定）。
 * 截图输出：logs/e2e-devices.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
/** 可选：传入自己真实的「健康」导出 zip，用它验收（不传就现场造一个 14 天的示例包） */
const CUSTOM_ZIP = process.argv[3] || process.env.E2E_ZIP || '';
const PORT = Number(process.env.CDP_PORT || 9333);
const SHOT = path.resolve('logs/e2e-devices.png');
const USER = process.env.SMARTFIT_USER || 'demo';
const PASS = process.env.SMARTFIT_PASS || '123456';

// ---------------------------------------------------------------- 找一个 Chromium 系浏览器
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('没找到 Edge/Chrome，可用 EDGE_PATH 环境变量指定可执行文件路径');
}

// ---------------------------------------------------------------- 造一份示例「健康」导出 zip
function buildSampleZip(filePath) {
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<HealthData locale="zh_CN">'];
  const today = new Date('2026-10-26T00:00:00Z');
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86400000);
    const date = d.toISOString().slice(0, 10);
    const next = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    lines.push(` <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="${date} 08:00:00 +0800" endDate="${date} 22:00:00 +0800" value="${8000 + i * 37}"/>`);
    lines.push(` <Record type="HKQuantityTypeIdentifierRestingHeartRate" unit="count/min" startDate="${date} 07:00:00 +0800" endDate="${date} 07:00:00 +0800" value="${62 + (i % 6)}"/>`);
    for (let m = 0; m < 60; m += 10) {
      lines.push(` <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="${date} 12:${String(m).padStart(2, '0')}:00 +0800" endDate="${date} 12:${String(m).padStart(2, '0')}:00 +0800" value="${70 + ((i + m) % 40)}"/>`);
    }
    lines.push(` <Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" startDate="${date} 07:30:00 +0800" endDate="${date} 07:30:00 +0800" value="${(70 + (i % 5) * 0.1).toFixed(1)}"/>`);
    lines.push(` <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="${date} 23:20:00 +0800" endDate="${next} 06:30:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>`);
  }
  lines.push('</HealthData>');
  const xml = Buffer.from(lines.join('\n'), 'utf8');

  const entries = [
    { name: 'apple_health_export/apple_health_export/hr.csv', data: Buffer.from('date,value\n', 'utf8') },
    { name: 'apple_health_export/export.xml', data: xml },
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(filePath, Buffer.concat([...locals, cdBuf, eocd]));
  return { days: 14 };
}

// ---------------------------------------------------------------- CDP 小工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = findBrowser();
const profileDir = path.join(os.tmpdir(), 'smartfit-e2e-profile');
const child = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,1500',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('浏览器调试端口没起来（被占用？可用 CDP_PORT 换一个）');
}

const ws = new WebSocket(await waitForTarget());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let msgId = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
    else res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    problems.push('[console.error] ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    problems.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
});

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const goto = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 120; i += 1) {
    await sleep(150);
    const ready = await evaluate('document.readyState').catch(() => 'loading');
    if (ready === 'complete') return;
  }
  throw new Error('页面加载超时：' + url);
};

// ---------------------------------------------------------------- 跑流程
const zipPath = CUSTOM_ZIP ? path.resolve(CUSTOM_ZIP) : path.join(os.tmpdir(), 'smartfit-e2e-导出.zip');
if (CUSTOM_ZIP) {
  assert.ok(fs.existsSync(zipPath), '找不到指定的导出文件：' + zipPath);
  console.log(`用你自己的导出验收：${zipPath}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB）`);
} else {
  buildSampleZip(zipPath);
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');

  console.log(`[1/5] 打开 ${BASE}/login`);
  await goto(`${BASE}/login`);

  console.log('[2/5] 用接口登录并把令牌写进 localStorage（跳过手点登录表单）');
  const login = await evaluate(`(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} }),
    }).then((x) => x.json()).catch((e) => ({ code: -1, message: String(e) }));
    if (r.code !== 0) return { ok: false, body: r };
    localStorage.setItem('smartfit_token', r.data.token);
    localStorage.setItem('smartfit_user', JSON.stringify(r.data.user || {}));
    return { ok: true };
  })()`);
  assert.ok(login?.ok, '登录失败：' + JSON.stringify(login));
  console.log('      登录成功');

  console.log('[3/5] 打开 /devices 并确认是新版页面');
  await goto(`${BASE}/devices`);
  await sleep(1500);
  const pageText = await evaluate('document.body.innerText || ""');
  assert.ok(pageText.includes('export.xml'), '页面里没有「export.xml」字样 —— 说明部署的还是旧版本前端');
  console.log('      新版标志「export.xml」已出现');

  console.log('[4/5] 把示例 zip 塞进 file input（等价于用户点「选择文件」并选中它）');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  assert.ok(input.nodeId, '页面上找不到 input[type=file]');
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [zipPath] });

  console.log('[5/5] 等页面解析并出预览');
  let state = null;
  // 注意：解析完先出「摘要」，预览表要等 /api/devices/import 的 dryRun 返回才有，
  // 所以这里必须等 previewTitle，而不是看到摘要就往下走（否则会误判成"没出预览"）
  for (let i = 0; i < 160; i += 1) {
    await sleep(500);
    state = await evaluate(`(() => ({
      note: (document.querySelector('.apple-note')?.textContent || '').trim(),
      previewTitle: (document.querySelector('.imp-preview-title')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      previewRows: document.querySelectorAll('.el-table__body tr').length,
      toasts: Array.from(document.querySelectorAll('.el-message')).map((el) => el.textContent.trim()),
    }))()`);
    if (state.previewTitle) break;
  }

  if (!state?.previewTitle) {
    console.log('      摘要：' + (state?.note || '(空)'));
    console.log('      页面提示：' + JSON.stringify(state?.toasts || []));
    throw new Error('没有出现预览表：' + JSON.stringify(state));
  }

  assert.ok(/解析出 \d+ 天/.test(state.note || ''), '没有出现解析摘要：' + JSON.stringify(state));
  assert.ok(/解析到 \d+ 行/.test(state.previewTitle || ''), '没有出现预览表：' + JSON.stringify(state));
  console.log('      ' + state.note);
  console.log('      ' + state.previewTitle);

  fs.mkdirSync('logs', { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('\n截图：' + SHOT);

  if (problems.length) {
    console.log('\n页面控制台错误：');
    problems.forEach((p) => console.log('  ' + p));
    throw new Error('页面出现了 JS 错误，见上');
  }
  console.log('\n通过：真浏览器里能选 zip → 自动解析 → 出预览\n');
} finally {
  ws.close();
  child.kill();
  // 只删我们自己造的临时包；用户传进来的真实导出不能动
  if (!CUSTOM_ZIP) fs.rmSync(zipPath, { force: true });
}
