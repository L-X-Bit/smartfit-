/**
 * 页面文字量体检：统计每个页面的可见文字（innerText）长度，用来量化"描述太多"。
 * 用法：node tools/text-volume.mjs [--mobile]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9390);
const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const API = process.env.API_URL || 'http://127.0.0.1:3000';
const MOBILE = process.argv.includes('--mobile');
const PROFILE = path.join(process.env.TEMP || '.', MOBILE ? 'edge-vol-m' : 'edge-vol-d');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  ['/dashboard', '数据总览'],
  ['/checkin', '运动打卡'],
  ['/plan', 'AI 健身计划'],
  ['/body', '身体数据'],
  ['/devices', '设备同步'],
  ['/analytics', '数据可视化'],
  ['/coach', 'AI 健身教练'],
  ['/diet', '健康饮食'],
  ['/food-scan', 'AI 拍照识热量'],
  ['/community', '运动社区'],
  ['/profile', '个人中心'],
];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 90000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return null;
    return r.result?.value;
  }
}

const login = await (await fetch(API + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: '123456' }),
})).json();
const token = login.data.token;
const user = JSON.stringify(login.data.user);

fs.rmSync(PROFILE, { recursive: true, force: true });
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' });
let targets = null;
for (let i = 0; i < 40 && !targets; i += 1) { await sleep(500); try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (t.length) targets = t; } catch {} }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', MOBILE
  ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
  : { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });

await cdp.send('Page.navigate', { url: APP + '/login' });
await sleep(2600);
await cdp.eval(`localStorage.setItem('smartfit_token', ${JSON.stringify(token)}); localStorage.setItem('smartfit_user', ${JSON.stringify(user)}); 'ok'`);

const rows = [];
for (const [route, name] of PAGES) {
  await cdp.send('Page.navigate', { url: APP + route });
  await sleep(1200);
  // 等主要内容渲染出来（最多 25 秒，线上冷启动也够）
  for (let i = 0; i < 25; i += 1) {
    const n = await cdp.eval(`document.querySelectorAll('.card').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(800);
  }
  await sleep(1600);
  const stat = await cdp.eval(`(() => {
    const t = (document.querySelector('.content') || document.body).innerText || '';
    const chars = t.replace(/\\s+/g, '').length;
    return { chars, lines: t.split('\\n').filter(Boolean).length };
  })()`);
  rows.push({ name, route, ...stat });
}

rows.sort((a, b) => b.chars - a.chars);
console.log(`\n===== 页面文字量（${MOBILE ? '手机 390×844' : '桌面 1600×1100'}）=====`);
console.log('字符数   行数   页面');
for (const r of rows) console.log(`${String(r.chars).padStart(6)}  ${String(r.lines).padStart(5)}   ${r.name} ${r.route}`);
console.log(`\n合计 ${rows.reduce((s, r) => s + r.chars, 0)} 字`);

proc.kill();
ws.close();
