/**
 * 线上验收脚本：对部署好的站点做一轮真实接口 + 页面探测
 * 用法：node tools/verify-online.mjs [https://你的域名]
 * 检查：健康检查 / 静态资源 / 11 个前端路由 / 登录 / 总览 / AI 状态 / 设备同步 / 打卡
 *       / AI 教练 SSE / 自动同步（令牌签发 → 令牌鉴权推送 → 日报表落库 → 撤销）
 */
const BASE = (process.argv[2] || process.env.ONLINE_URL || 'https://smartfit-qsyh.onrender.com').replace(/\/$/, '');

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log('  ✓ ' + m);
};
const bad = (m) => {
  fail += 1;
  console.log('  ✗ ' + m);
};

async function req(path, { method = 'GET', token, body, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000), // 免费实例休眠唤醒较慢
  });
  if (raw) return { status: res.status, text: await res.text() };
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

console.log(`\n===== 线上验收：${BASE} =====\n`);

console.log('【1】基础存活');
const h = await req('/api/health', { raw: true });
h.status === 200 && h.text.includes('智练') ? ok(`健康检查 200（${h.text.slice(0, 90)}…）`) : bad(`健康检查异常 ${h.status}`);

const home = await req('/', { raw: true });
home.status === 200 && /智练 SmartFit/.test(home.text) ? ok('首页返回 SPA（title 含“智练 SmartFit”）') : bad(`首页异常 ${home.status}`);

console.log('\n【2】11 个前端路由（history 模式应全部回落 index.html）');
const routes = ['/dashboard', '/checkin', '/plan', '/body', '/devices', '/analytics', '/coach', '/diet', '/food-scan', '/community', '/profile', '/login'];
for (const r of routes) {
  const res = await req(r, { raw: true });
  res.status === 200 && res.text.includes('<div id="app">') ? ok(`${r} 200`) : bad(`${r} ${res.status}`);
}

console.log('\n【3】登录 + 业务数据');
const login = await req('/api/auth/login', { method: 'POST', body: { username: 'demo', password: '123456' } });
const token = login.json?.data?.token;
token ? ok(`demo 登录成功（${login.json.data.user?.nickname || 'demo'}）`) : bad(`登录失败 ${login.status} ${login.json?.message || ''}`);

if (token) {
  const ov = await req('/api/dashboard/overview', { token });
  ov.status === 200 && ov.json.code === 0
    ? ok(`总览数据：今日消耗 ${ov.json.data?.today?.burn ?? '?'} kcal / 摄入 ${ov.json.data?.today?.intake ?? '?'} kcal / 连续 ${ov.json.data?.streak ?? 0} 天`)
    : bad(`总览失败 ${ov.status}`);

  const ai = await req('/api/ai/status', { token }); // 注意：线上该接口需要登录态
  const d = ai.json?.data || {};
  d.enabled ? ok(`AI 已接通：${d.model}（provider ${d.provider}）`) : bad(`AI 未启用（enabled=${d.enabled}），线上会降级为规则引擎`);

  const dev = await req('/api/devices/status', { token });
  dev.status === 200 ? ok(`设备同步可用：已同步 ${dev.json.data?.syncCount ?? 0} 次`) : bad(`设备同步 ${dev.status}`);

  const st = await req('/api/checkin/stats', { token });
  st.status === 200 ? ok(`打卡统计可用：本周 ${st.json.data?.week?.total ?? st.json.data?.weekCount ?? '?'} 次`) : bad(`打卡统计 ${st.status}`);

  const plan = await req('/api/plan/list', { token });
  plan.status === 200 ? ok(`训练计划列表可用：${(plan.json.data || []).length} 个计划`) : bad(`计划列表 ${plan.status}`);

  const body = await req('/api/body/analysis', { token });
  body.status === 200 ? ok(`身体数据分析可用：BMI ${body.json.data?.bmi?.value ?? '?'}`) : bad(`身体数据 ${body.status}`);
}

console.log('\n【4】AI 教练 SSE 流式');
try {
  const res = await fetch(BASE + '/api/ai/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ question: '线上验收：我一周练三次，怎么安排减脂？' }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  const deltas = (text.match(/event: delta/g) || []).length;
  res.status === 200 && deltas > 5 ? ok(`SSE 正常：收到 ${deltas} 个 delta 帧`) : bad(`SSE 异常 status=${res.status} deltas=${deltas}`);
} catch (e) {
  bad('SSE 请求失败：' + e.message);
}

console.log('\n【5】自动同步（同步令牌 + 免登录推送）');
if (token) {
  // 令牌鉴权请求：模拟 iPhone 快捷指令 / health-sync.mjs 的调用方式
  const syncReq = async (path, { method = 'GET', syncToken, body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(syncToken ? { 'X-Sync-Token': syncToken } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90000),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const setup = await req('/api/sync/setup', { token });
  const pushUrl = setup.json?.data?.pushUrl || '';
  // 期望的协议跟着被测站点走：线上必须是 https（iOS ATS 会拦 http），本地跑就是 http
  const expectProto = BASE.startsWith('https') ? 'https://' : 'http://';
  pushUrl.startsWith(expectProto)
    ? ok(`自助配置可用：推送地址 ${pushUrl}（反代协议识别正确）`)
    : bad(`推送地址异常：${pushUrl || setup.status}`);

  const tk = await req('/api/sync/tokens', { method: 'POST', token, body: { name: '线上验收' } });
  const syncToken = tk.json?.data?.token || '';
  syncToken.startsWith('sft_') ? ok(`令牌签发成功（${tk.json.data.hint}…，明文只返回一次）`) : bad(`令牌签发失败 ${tk.status} ${tk.json?.message || ''}`);

  if (syncToken) {
    const ping = await syncReq('/api/sync/ping', { syncToken });
    ping.json?.code === 0 ? ok(`令牌鉴权通过：${ping.json.data?.tokenName || '线上验收'}`) : bad(`ping 失败 ${ping.status}`);

    // 推一个可识别的步数，再回查日报表，证明真的落库（而不只是返回 200）
    const d0 = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const testDate = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}`;
    const push = await syncReq('/api/sync/push', {
      method: 'POST',
      syncToken,
      body: { device: '线上验收·自动同步', date: testDate, metrics: { steps: 6001, restingHr: 58, sleepHours: 7.7 } },
    });
    push.json?.code === 0 ? ok(`推送成功：${push.json.data?.summary}`) : bad(`推送失败 ${push.status} ${push.json?.message || ''}`);

    const daily = await req('/api/devices/daily?days=7', { token });
    const row = (daily.json?.data?.list || []).find((x) => x.date === testDate);
    row?.steps === 6001 && row?.sleepHours === 7.7
      ? ok(`日报表已落库：${testDate} ${row.steps} 步 / ${row.restingHr} bpm / ${row.sleepHours}h`)
      : bad(`日报表未反映推送数据：${JSON.stringify(row || null)}`);

    // GET 版本（iPhone 快捷指令最省事的用法）
    const getPush = await syncReq(`/api/sync/push?token=${encodeURIComponent(syncToken)}&steps=6002`, {});
    getPush.json?.code === 0 ? ok('GET 版推送可用（快捷指令单网址即可）') : bad(`GET 推送失败 ${getPush.status}`);

    const rev = await req(`/api/sync/tokens/${tk.json.data.id}`, { method: 'DELETE', token });
    rev.json?.code === 0 ? ok('令牌撤销成功') : bad(`撤销失败 ${rev.status}`);
    const after = await syncReq('/api/sync/ping', { syncToken });
    after.status === 401 ? ok('撤销后令牌立即失效（401）') : bad(`撤销后仍可用 ${after.status}`);
  }
} else {
  bad('没有登录态，跳过自动同步验收');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`);
process.exit(fail > 0 ? 1 : 0);
