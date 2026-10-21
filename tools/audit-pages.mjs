/**
 * 页面功能体检脚本（本地验收用）
 * ---------------------------------------------------------------------------
 * 用途：新增功能后确认「原有功能一个都没少」。逐页访问 10 个页面，
 *      检查每页的标志性文案是否渲染，并读取侧边栏菜单项，最后输出体检报告。
 * 用法：node tools/audit-pages.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9355);
const PROFILE = path.join(process.env.TEMP || '.', 'edge-audit-prof');
const APP = process.env.APP_URL || 'http://127.0.0.1:5173';
const API = process.env.API_URL || 'http://127.0.0.1:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每页应出现的标志性文案（用于判断该功能是否还在） */
const PAGES = [
  { path: '/dashboard', name: '数据总览', must: ['今日运动消耗', '今日饮食摄入', 'AI 智能建议', '今日训练计划'] },
  { path: '/checkin', name: '运动打卡', must: ['快速打卡', '打卡日历', '运动类型分布'] },
  { path: '/plan', name: 'AI 健身计划', must: ['AI 训练计划生成器', '训练经验', '伤病'] },
  { path: '/body', name: '身体数据', must: ['六维健康评分', '基础代谢', '历史记录'] },
  { path: '/analytics', name: '数据可视化', must: ['本周训练完成度', '训练部位均衡度', '打卡热力图'] },
  { path: '/coach', name: 'AI 健身教练', must: ['小智', '注入给 AI 的数据快照', '推荐提问'] },
  // 饮食页要额外确认「内嵌的拍照识别面板」仍然存在
  { path: '/diet', name: '健康饮食', must: ['今日热量', '三大营养素供能比', 'AI 一日配餐推荐', '拍照识别食物热量'] },
  { path: '/food-scan', name: 'AI 拍照识热量', must: ['AI 拍照识热量', '份量试算', '识别历史', '识别是怎么做的'] },
  { path: '/community', name: '运动社区', must: ['本周打卡榜', '热门话题', '发布'] },
  { path: '/profile', name: '个人中心', must: ['基础档案', 'AI 运行统计', '平台信息'] },
];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return null;
    return r.result?.value;
  }
}

(async () => {
  const login = await (await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: '123456' }),
  })).json();
  const token = login.data.token;
  const user = JSON.stringify(login.data.user);

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, '--window-size=1600,1100', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch {}
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 必须显式设定视口：headless 默认窗口很窄，会触发 ≤900px 断点把侧边栏折叠，
  // 导致菜单读不到（这不是功能丢失，而是响应式生效）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });

  // 注入登录态
  await cdp.send('Page.navigate', { url: APP + '/login' });
  await sleep(2500);
  await cdp.eval(`localStorage.setItem('smartfit_token', ${JSON.stringify(token)}); localStorage.setItem('smartfit_user', ${JSON.stringify(user)}); 'ok'`);

  // ---------- 侧边栏菜单 ----------
  await cdp.send('Page.navigate', { url: APP + '/dashboard' });
  await sleep(3000);
  const menus = await cdp.eval(`[...document.querySelectorAll('.sidebar .menu-item')].map(a => a.textContent.trim().replace(/\\s+/g, ' '))`);
  const menuHrefs = await cdp.eval(`[...document.querySelectorAll('.sidebar .menu-item')].map(a => a.getAttribute('href'))`);
  console.log('\n=== 侧边栏菜单（共 ' + (menus?.length || 0) + ' 项）===');
  (menus || []).forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m}`));

  // 菜单必须覆盖所有页面：这里做硬断言，防止「菜单静默变空 / 新增页面忘记加入菜单」这类回归
  let fail = 0;
  const missingMenus = PAGES.filter((p) => !(menuHrefs || []).includes(p.path));
  if (missingMenus.length) {
    fail += 1;
    console.log(`  ✗ 菜单缺失 ${missingMenus.length} 项：${missingMenus.map((p) => p.path).join('、')}`);
  } else {
    console.log(`  ✓ 菜单覆盖全部 ${PAGES.length} 个页面`);
  }

  // ---------- 逐页体检 ----------
  console.log('\n=== 逐页功能体检 ===');
  let pass = 0;
  for (const page of PAGES) {
    await cdp.send('Page.navigate', { url: APP + page.path });
    await sleep(2600);
    const text = (await cdp.eval(`document.body.innerText`)) || '';
    const missing = page.must.filter((k) => !text.includes(k));
    if (missing.length === 0) {
      pass += 1;
      console.log(`  ✓ ${page.name.padEnd(12)} ${page.path.padEnd(12)} 全部 ${page.must.length} 个标志项通过`);
    } else {
      fail += 1;
      console.log(`  ✗ ${page.name.padEnd(12)} ${page.path.padEnd(12)} 缺少: ${missing.join('、')}`);
    }
  }

  console.log(`\n========== 体检结果：${pass} 页通过 / ${fail} 页异常 ==========`);
  ws.close();
  try { proc.kill(); } catch {}
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('体检脚本异常:', e.message);
  process.exit(2);
});
