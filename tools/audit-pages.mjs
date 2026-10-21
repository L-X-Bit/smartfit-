/**
 * 页面功能体检脚本（桌面 / 移动端）
 * ---------------------------------------------------------------------------
 * 用途：新增功能或改动布局后，确认「原有功能一个都没少」，并且移动端布局没有撑破。
 * 用法：
 *   node tools/audit-pages.mjs            # 桌面 1600×1100
 *   node tools/audit-pages.mjs --mobile   # 手机 390×844（iPhone 14 逻辑分辨率）
 *
 * 检查项：
 *   1. 侧边栏菜单必须覆盖所有页面（防止菜单静默变空）
 *   2. 每页的标志性文案必须渲染（判断该功能是否还在）
 *   3. 移动端专项：整页不得出现横向溢出、侧边栏应折叠、汉堡按钮应出现、抽屉菜单应有全部页面
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9355);
const APP = process.env.APP_URL || 'http://127.0.0.1:5173';
const API = process.env.API_URL || 'http://127.0.0.1:3000';
const MOBILE = process.argv.includes('--mobile');
const PROFILE = path.join(process.env.TEMP || '.', MOBILE ? 'edge-audit-mobile' : 'edge-audit-desktop');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每页应出现的标志性文案 */
const PAGES = [
  { path: '/dashboard', name: '数据总览', must: ['今日运动消耗', '今日饮食摄入', 'AI 智能建议', '今日训练计划'] },
  { path: '/checkin', name: '运动打卡', must: ['快速打卡', '打卡日历', '运动类型分布'] },
  { path: '/plan', name: 'AI 健身计划', must: ['AI 训练计划生成器', '训练经验', '伤病'] },
  { path: '/body', name: '身体数据', must: ['六维健康评分', '基础代谢', '历史记录'] },
  { path: '/analytics', name: '数据可视化', must: ['本周训练完成度', '训练部位均衡度', '打卡热力图'] },
  { path: '/coach', name: 'AI 健身教练', must: ['小智', '推荐提问'] },
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
    `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch {}
  }
  if (!targets?.length) throw new Error('无法连接 Edge 调试端口');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 视口：桌面 1600×1100 / 手机 390×844
  if (MOBILE) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  }

  // 登录态
  await cdp.send('Page.navigate', { url: APP + '/login' });
  await sleep(2500);
  await cdp.eval(`localStorage.setItem('smartfit_token', ${JSON.stringify(token)}); localStorage.setItem('smartfit_user', ${JSON.stringify(user)}); 'ok'`);

  let fail = 0;
  console.log(`\n=========== ${MOBILE ? '移动端（390×844）' : '桌面端（1600×1100）'}体检 ===========`);

  // ---------- 导航检查 ----------
  await cdp.send('Page.navigate', { url: APP + '/dashboard' });
  await sleep(3000);

  if (MOBILE) {
    // 手机端：侧边栏应折叠、汉堡按钮应出现、抽屉里应有全部页面
    const sidebarDisplay = await cdp.eval(`(() => { const s = document.querySelector('.sidebar'); return s ? getComputedStyle(s).display : 'no-el'; })()`);
    const hamburgerDisplay = await cdp.eval(`(() => { const h = document.querySelector('.hamburger'); return h ? getComputedStyle(h).display : 'no-el'; })()`);
    console.log('\n--- 移动端导航 ---');
    console.log(`  侧边栏 display: ${sidebarDisplay} ${sidebarDisplay === 'none' ? '✓ 已折叠' : '✗ 应折叠'}`);
    if (sidebarDisplay !== 'none') fail += 1;
    console.log(`  汉堡按钮 display: ${hamburgerDisplay} ${hamburgerDisplay !== 'none' ? '✓ 可见' : '✗ 不可见'}`);
    if (hamburgerDisplay === 'none') fail += 1;

    await cdp.eval(`document.querySelector('.hamburger')?.click(); 'clicked'`);
    await sleep(1400);
    const drawerHrefs = await cdp.eval(`[...document.querySelectorAll('.nav-drawer .menu-item')].map(a => a.getAttribute('href'))`);
    const drawerMissing = PAGES.filter((p) => !(drawerHrefs || []).includes(p.path));
    console.log(`  抽屉菜单: ${(drawerHrefs || []).length} 项 ${drawerMissing.length ? '✗ 缺 ' + drawerMissing.map((p) => p.path).join('、') : '✓ 覆盖全部页面'}`);
    if (drawerMissing.length) fail += 1;
    // 关闭抽屉，避免遮挡后续页面检查
    await cdp.eval(`document.querySelector('.el-drawer__close-btn')?.click(); document.querySelector('.el-overlay')?.click(); 'closed'`);
    await sleep(600);
  } else {
    const menuHrefs = await cdp.eval(`[...document.querySelectorAll('.sidebar .menu-item')].map(a => a.getAttribute('href'))`);
    const menus = await cdp.eval(`[...document.querySelectorAll('.sidebar .menu-item')].map(a => a.textContent.trim().replace(/\\s+/g, ' '))`);
    console.log('\n--- 侧边栏菜单（' + (menus?.length || 0) + ' 项）---');
    (menus || []).forEach((m, i) => console.log(`  ${String(i + 1).padStart(2)}. ${m}`));
    const missingMenus = PAGES.filter((p) => !(menuHrefs || []).includes(p.path));
    console.log(`  ${missingMenus.length ? '✗ 菜单缺失: ' + missingMenus.map((p) => p.path).join('、') : `✓ 菜单覆盖全部 ${PAGES.length} 个页面`}`);
    if (missingMenus.length) fail += 1;
  }

  // ---------- 逐页检查 ----------
  console.log('\n--- 逐页功能与布局 ---');
  let pass = 0;
  for (const page of PAGES) {
    await cdp.send('Page.navigate', { url: APP + page.path });
    await sleep(2600);

    const text = (await cdp.eval(`document.body.innerText`)) || '';
    const missing = page.must.filter((k) => !text.includes(k));

    // 横向溢出检测：整页可左右拖动 = 移动端布局被撑破
    const overflow = await cdp.eval(`(() => {
      const dw = document.documentElement.scrollWidth;
      const vw = window.innerWidth;
      return { dw, vw, overflow: dw - vw };
    })()`);
    const hasOverflow = overflow && overflow.overflow > 3;

    // 找出最宽的几个越界元素，便于定位是谁撑破的
    let culprits = [];
    if (hasOverflow) {
      culprits = (await cdp.eval(`(() => {
        const vw = window.innerWidth;
        const out = [];
        for (const el of document.querySelectorAll('.content *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > vw + 4) {
            const cls = (el.className && typeof el.className === 'string') ? el.className.split(' ').slice(0, 2).join('.') : el.tagName;
            out.push(cls + ' (+' + Math.round(r.right - vw) + 'px)');
          }
        }
        return [...new Set(out)].slice(0, 4);
      })()`)) || [];
    }

    const ok = missing.length === 0 && !hasOverflow;
    if (ok) {
      pass += 1;
      console.log(`  ✓ ${page.name.padEnd(12)} ${page.path.padEnd(12)} 文案 ${page.must.length}/${page.must.length}  横向溢出 无`);
    } else {
      fail += 1;
      const parts = [];
      if (missing.length) parts.push(`缺文案: ${missing.join('、')}`);
      if (hasOverflow) parts.push(`横向溢出 ${overflow.overflow}px → 越界元素: ${culprits.join(' / ') || '未定位'}`);
      console.log(`  ✗ ${page.name.padEnd(12)} ${page.path.padEnd(12)} ${parts.join(' | ')}`);
    }
  }

  console.log(`\n========== 结果：${pass} 页通过 / ${fail} 项异常 ==========`);
  ws.close();
  try { proc.kill(); } catch {}
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('体检脚本异常:', e.message);
  process.exit(2);
});
