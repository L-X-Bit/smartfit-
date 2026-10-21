/**
 * CDP 驱动的页面截图工具（本地验收用，不参与项目运行）
 * ---------------------------------------------------------------------------
 * 用途：录制演示前自动走一遍「登录 → 进页 → 点按钮 → 等真实 AI 返回 → 截图」，
 *      确认在真实大模型数据下每页布局没有被长文本/大数据撑坏。
 * 原理：启动 Edge 无头模式并开远程调试端口，用 CDP 通过 WebSocket 发命令。
 *
 * 用法：
 *   node tools/cdp-shot.mjs                # 全部 10 个页面
 *   node tools/cdp-shot.mjs diet plan      # 只重截指定页面
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径与地址都做成可配置项，避免在仓库里写死某台机器的绝对路径
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = path.join(process.env.TEMP || '.', 'edge-cdp-prof');
const APP = process.env.APP_URL || 'http://127.0.0.1:5173';
const API = process.env.API_URL || 'http://127.0.0.1:3000';
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-'));
/** --mobile：用 390x844（iPhone 14 逻辑分辨率）验证移动端布局，截图输出到 screenshots/mobile/ */
const MOBILE = process.argv.includes('--mobile');
/** --full：截整页长图（captureBeyondViewport），用于核对页面区块完整性 */
const FULL_PAGE = process.argv.includes('--full');
const OUT_DIR = MOBILE ? path.join(ROOT, 'docs', 'screenshots', 'mobile') : path.join(ROOT, 'docs', 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const need = (key) => ONLY.length === 0 || ONLY.includes(key);

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
      }, 200000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }
  async shot(file, fullPage = false) {
    let params = { format: 'png', captureBeyondViewport: false };
    if (fullPage) {
      // 整页长图：取文档实际尺寸作为 clip，一次截完（含滚动区域外的内容）
      const m = await this.send('Page.getLayoutMetrics');
      const w = Math.ceil(m.cssContentSize?.width || m.contentSize?.width || 1600);
      const h = Math.min(20000, Math.ceil(m.cssContentSize?.height || m.contentSize?.height || 1100));
      params = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } };
    }
    const r = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

/** 等待页面加载完成且 origin 可写（about:blank 属于 opaque origin，此时访问 localStorage 会抛 SecurityError） */
async function waitReady(cdp, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await cdp.eval(`document.readyState === 'complete' && location.origin !== 'null'`).catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function waitFor(cdp, expression, timeoutMs = 120000, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await cdp.eval(`Boolean(${expression})`)) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error(`等待超时(${label}): ${expression}`);
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
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1600,1100', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; } catch {}
  }
  if (!targets?.length) throw new Error('无法连接 Edge 调试端口');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  if (MOBILE) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    fs.mkdirSync(OUT_DIR, { recursive: true });
  } else {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  }

  async function goto(route) {
    await cdp.send('Page.navigate', { url: APP + '/login' });
    await waitReady(cdp);
    // 注入登录态，失败时重试（移动端模拟下页面就绪偶有延迟）
    let injected = false;
    for (let i = 0; i < 6 && !injected; i += 1) {
      try {
        await cdp.eval(`localStorage.setItem('smartfit_token', ${JSON.stringify(token)}); localStorage.setItem('smartfit_user', ${JSON.stringify(user)}); 'ok'`);
        injected = true;
      } catch {
        await sleep(500);
      }
    }
    if (!injected) throw new Error('无法注入登录态（localStorage 不可写）');
    await cdp.send('Page.navigate', { url: APP + route });
    await sleep(2600);
  }
  async function save(name) {
    const f = path.join(OUT_DIR, name + '.png');
    if (FULL_PAGE) {
      /**
       * 整页长图：本项目的滚动容器是 .content（不是 document —— 布局是 .layout{100vh;overflow:hidden}），
       * 所以要把视口临时拉到「顶栏 + .content 的 scrollHeight」，让内容一次性全部铺开再截图，
       * 截完再恢复原视口，避免影响后续步骤。
       */
      const need = await cdp.eval(`(() => {
        const c = document.querySelector('.content');
        const h = c ? c.scrollHeight : document.documentElement.scrollHeight;
        return Math.min(20000, Math.max(1100, h + 90));
      })()`);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: MOBILE ? 390 : 1600,
        height: need,
        deviceScaleFactor: MOBILE ? 2 : 1,
        mobile: MOBILE,
      });
      await sleep(900);
      await cdp.shot(f);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: MOBILE ? 390 : 1600,
        height: MOBILE ? 844 : 1100,
        deviceScaleFactor: MOBILE ? 2 : 1,
        mobile: MOBILE,
      });
      console.log(`  ✓ ${name}.png (${(fs.statSync(f).size / 1024).toFixed(0)} KB, 整页高 ${need}px)`);
      return;
    }
    await cdp.shot(f);
    console.log(`  ✓ ${name}.png (${(fs.statSync(f).size / 1024).toFixed(0)} KB)`);
  }

  // ============ 1. 登录页
  if (need('login')) {
    console.log('[login]');
    await cdp.send('Page.navigate', { url: APP + '/login' });
    await waitReady(cdp);
    await sleep(2000);
    await save('00-login');
  }

  // ============ 2. 数据总览
  if (need('dashboard')) {
    console.log('[dashboard]');
    await goto('/dashboard');
    await waitFor(cdp, `document.body.innerText.includes('今日运动消耗')`, 30000, 'dashboard');
    await sleep(1500);
    await save('01-dashboard');
  }

  // ============ 3. 运动打卡
  if (need('checkin')) {
    console.log('[checkin]');
    await goto('/checkin');
    await waitFor(cdp, `document.body.innerText.includes('快速打卡')`, 30000, 'checkin');
    await sleep(1800);
    await save('02-checkin');
  }

  // ============ 4. AI 计划（点生成，等真模型）
  if (need('plan')) {
    console.log('[plan] 点击生成，等待真实大模型…');
    await goto('/plan');
    await waitFor(cdp, `document.body.innerText.includes('AI 训练计划生成器')`, 30000, 'plan');
    await sleep(1000);
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('生成我的专属计划')); if(b){b.click();return 'clicked';} return 'not-found'; })()`);
    await waitFor(cdp, `document.body.innerText.includes('大模型生成') && !document.body.innerText.includes('AI 正在生成') && document.body.innerText.includes('总耗时')`, 180000, 'plan-generated');
    await sleep(2500);
    const info = await cdp.eval(`(document.body.innerText.match(/计划生成完成[^\\n]*/) || [''])[0]`);
    console.log('  ' + info);
    await save('03-plan');
  }

  // ============ 5. 身体数据
  if (need('body')) {
    console.log('[body]');
    await goto('/body');
    await waitFor(cdp, `document.body.innerText.includes('六维健康评分')`, 30000, 'body');
    await sleep(1800);
    await save('04-body');
  }

  // ============ 6. 数据可视化
  if (need('analytics')) {
    console.log('[analytics]');
    await goto('/analytics');
    await waitFor(cdp, `document.body.innerText.includes('本周训练完成度')`, 30000, 'analytics');
    await sleep(2000);
    await save('05-analytics');
  }

  // ============ 7. AI 教练（发问题，等流式结束）
  if (need('coach')) {
    console.log('[coach] 提问并等待流式回答…');
    await goto('/coach');
    await waitFor(cdp, `document.body.innerText.includes('小智')`, 30000, 'coach');
    await sleep(800);
    await cdp.eval(`(() => {
      const ta = document.querySelector('.chat-input textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '我一周只能练三次，膝盖有旧伤，怎么安排减脂训练？');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const b = [...document.querySelectorAll('.chat-input button')].find(x => x.textContent.includes('发送'));
      if (b) { b.click(); return 'sent'; }
      return 'no-button';
    })()`);
    await waitFor(cdp, `document.querySelectorAll('.msg.assistant').length >= 1 && !document.querySelector('.bubble.typing') && ((document.querySelector('.msg.assistant .bubble') || {}).innerText || '').length > 60`, 150000, 'coach-answer');
    await sleep(3500);
    await save('06-coach');
  }

  // ============ 8. 健康饮食（点生成配餐）
  if (need('diet')) {
    console.log('[diet] 点击生成配餐…');
    await goto('/diet');
    await waitFor(cdp, `document.body.innerText.includes('今日热量')`, 30000, 'diet');
    await sleep(800);
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('生成配餐')); if(b){b.click();return 'clicked';} return 'not-found'; })()`);
    await waitFor(cdp, `document.body.innerText.includes('一键采纳到今日饮食') && document.body.innerText.includes('与目标偏差')`, 180000, 'diet-result');
    await sleep(2000);
    const info = await cdp.eval(`(document.body.innerText.match(/(与目标偏差[^\\n]*)/) || [''])[0]`);
    console.log('  ' + info);
    await save('07-diet');
  }

  // ============ AI 拍照识热量（自动上传一张测试图，走完整前端流程）
  if (need('foodscan')) {
    console.log('[foodscan] 上传测试图并等待识别…');
    const testImg = process.env.FOOD_TEST_IMG || path.join(process.env.TEMP || '.', 'food-noodles.jpg');
    await goto('/food-scan');
    await waitFor(cdp, `document.body.innerText.includes('AI 拍照识热量')`, 30000, 'foodscan');
    await sleep(1000);
    if (fs.existsSync(testImg)) {
      const b64 = fs.readFileSync(testImg).toString('base64');
      // 通过 DataTransfer 把图片塞进隐藏的 input，并派发 change 事件 —— 完全走真实前端流程
      // （等价于用户点「从相册选择」，而不是绕过 UI 直接调接口）
      const dispatch = await cdp.eval(`(async () => {
        const dataUrl = 'data:image/jpeg;base64,${b64}';
        const blob = await (await fetch(dataUrl)).blob();
        const file = new File([blob], 'food.jpg', { type: 'image/jpeg' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.querySelector('input[type="file"]');
        if (!input) return 'no-input';
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'dispatched';
      })()`);
      console.log('   注入文件:', dispatch);
      await waitFor(
        cdp,
        `document.body.innerText.includes('库内精确') || document.body.innerText.includes('模型估算') || document.body.innerText.includes('没有识别到食物')`,
        150000,
        'foodscan-result',
      );
      await sleep(2200);
      const info = await cdp.eval(`(document.body.innerText.match(/这一餐约\\s*\\d+\\s*kcal|识别完成[^\\n]*/) || [''])[0]`);
      console.log('   结果:', info);
      // 继续验证「份量试算 + AI 建议」：带入识别结果 → 点 AI 分析 → 等建议返回
      const filled = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('带入上方识别结果'));
        if (!b) return 'no-button';
        b.click(); return 'clicked';
      })()`);
      console.log('   带入试算:', filled);
      await sleep(1000);
      const asked = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('AI 分析这一餐'));
        if (!b) return 'no-button';
        b.click(); return 'clicked';
      })()`);
      console.log('   AI 分析:', asked);
      await waitFor(cdp, `document.body.innerText.includes('依据你的身体条件')`, 120000, 'meal-advice');
      await sleep(1500);
    } else {
      console.log('   ⚠ 未找到测试图片，仅截图空状态：', testImg);
      await sleep(600);
    }
    await save('10-foodscan');
  }
  // ============ 9. 社区
  if (need('community')) {
    console.log('[community]');
    await goto('/community');
    await waitFor(cdp, `document.body.innerText.includes('本周打卡榜')`, 30000, 'community');
    await sleep(1800);
    await save('08-community');
  }

  // ============ 11. 拍照识别食物热量（多模态，需要真实图片）
  if (need('vision')) {
    const imgPath = process.env.TEST_FOOD_IMAGE || path.join(process.env.TEMP || '.', 'test-food.jpg');
    if (!fs.existsSync(imgPath)) {
      console.log('[vision] 跳过：未找到测试图片 ' + imgPath + '（可用 TEST_FOOD_IMAGE 环境变量指定）');
    } else {
      console.log('[vision] 上传食物照片，等待 AI 识别…');
      await goto('/diet');
      await waitFor(cdp, `document.body.innerText.includes('拍照识别食物热量')`, 30000, 'diet-vision');
      await sleep(1000);
      // 通过 CDP 给隐藏的 file input 设置本地文件（等价于用户选图），会自动派发 change 事件
      const doc = await cdp.send('DOM.getDocument', { depth: 2 });
      const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
      if (!found.nodeId) throw new Error('未找到 file input');
      await cdp.send('DOM.setFileInputFiles', { files: [imgPath], nodeId: found.nodeId });
      await waitFor(cdp, `document.querySelectorAll('.vision-item').length > 0`, 150000, 'vision-result');
      await sleep(1200);
      // 滚动到拍照识别卡片，保证截图能拍到识别结果区
      await cdp.eval(`document.querySelector('.vision-body')?.scrollIntoView({ block: 'start' }); 'ok'`);
      await sleep(900);
      const summary = await cdp.eval(`(document.body.innerText.match(/合计\\s*\\d+\\s*kcal/) || [''])[0]`);
      console.log('  ' + summary);
      await save('10-vision');
    }
  }

  // ============ 12. 个人中心
  if (need('profile')) {
    console.log('[profile]');
    await goto('/profile');
    await waitFor(cdp, `document.body.innerText.includes('AI 运行统计')`, 30000, 'profile');
    await sleep(1800);
    await save('09-profile');
  }

  console.log('\n完成。');
  ws.close();
  try { proc.kill(); } catch {}
  process.exit(0);
})().catch((err) => {
  console.error('\n✗ 失败:', err.message);
  process.exit(1);
});
