/**
 * 页面文字明细体检：把每页里"较长的可见文案"逐条列出来（标签/class/字数/内容），
 * 用来定位"描述太多"到底多在哪一段，好做删减。
 * 用法：node tools/text-audit.mjs [路由1 路由2 ...]   默认全部页面
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9391);
const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const API = process.env.API_URL || 'http://127.0.0.1:3000';
const PROFILE = path.join(process.env.TEMP || '.', 'edge-audit-txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL = {
  '/dashboard': '数据总览',
  '/checkin': '运动打卡',
  '/plan': 'AI 健身计划',
  '/body': '身体数据',
  '/devices': '设备同步',
  '/analytics': '数据可视化',
  '/coach': 'AI 健身教练',
  '/diet': '健康饮食',
  '/food-scan': 'AI 拍照识热量',
  '/community': '运动社区',
  '/profile': '个人中心',
};
const argRoutes = process.argv.slice(2).filter((a) => a.startsWith('/'));
const PAGES = argRoutes.length ? argRoutes.map((r) => [r, ALL[r] || r]) : Object.entries(ALL);

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
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });

await cdp.send('Page.navigate', { url: APP + '/login' });
await sleep(2600);
await cdp.eval(`localStorage.setItem('smartfit_token', ${JSON.stringify(token)}); localStorage.setItem('smartfit_user', ${JSON.stringify(user)}); 'ok'`);

const MIN = Number(process.env.MIN_CHARS || 12);
for (const [route, name] of PAGES) {
  await cdp.send('Page.navigate', { url: APP + route });
  await sleep(1200);
  for (let i = 0; i < 25; i += 1) {
    const n = await cdp.eval(`document.querySelectorAll('.card').length`).catch(() => 0);
    if (n > 0) break;
    await sleep(800);
  }
  await sleep(1600);
  const rows = await cdp.eval(`(() => {
    const out = [];
    const root = document.querySelector('.content') || document.body;
    for (const el of root.querySelectorAll('*')) {
      if (!el.childNodes.length) continue;
      // 只取"自身直接文本"够长的元素，避免父节点把整页算成一条
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = own.replace(/\\s+/g, ' ').trim();
      if (own.length < ${MIN}) continue;
      out.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 42), len: own.length, text: own.slice(0, 160) });
    }
    return out;
  })()`);
  const list = (rows || []).sort((a, b) => b.len - a.len);
  const total = list.reduce((s, r) => s + r.len, 0);
  console.log(`\n\n==================== ${name} ${route}  长文案 ${list.length} 条 / 共 ${total} 字 ====================`);
  for (const r of list.slice(0, Number(process.env.TOP || 40))) {
    console.log(`[${String(r.len).padStart(3)}] ${r.tag}.${r.cls}  ${r.text}${r.len > 160 ? '…' : ''}`);
  }
}

proc.kill();
ws.close();
