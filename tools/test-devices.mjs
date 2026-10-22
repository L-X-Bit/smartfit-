/**
 * 设备同步接口自测脚本
 * ===========================================================================
 * 用法：node tools/test-devices.mjs
 * 覆盖：status / demo（生成 7 天）/ daily / history / import（预览 + 真实导入）/ heart-rate
 *       / sync 自动同步（令牌签发 → 令牌鉴权推送 → 同日期合并 → 撤销后失效）
 * 为什么要有它：Web Bluetooth 必须真机，但「写入是否正确」可以完全离线验证——
 *   确认步数真的变成打卡、心率真的写进身体数据，而不是只往 device_syncs 里塞一条日志。
 */
const API = process.env.API_URL || 'http://127.0.0.1:3000';

async function call(method, url, body, token) {
  const res = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`${method} ${url} → ${res.status} ${json.message || ''}`);
  return json.data;
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const line = (t) => console.log('\n=== ' + t + ' ===');

const { token, user } = await call('POST', '/api/auth/login', { username: 'demo', password: '123456' });
console.log(`✓ 登录 ${user.nickname || user.username}`);

line('1. 能力与概览 GET /api/devices/status');
const st = await call('GET', '/api/devices/status', null, token);
console.log(`  已同步 ${st.syncCount} 次；最近：${st.lastSync ? st.lastSync.summary : '无'}`);
console.log(`  最新身体数据：${JSON.stringify(st.latestBody)}`);
console.log(`  导入模板首行：${st.importTemplate.split('\n')[0]}`);

line('2. 演示模式 POST /api/devices/demo {days:7}');
const demo = await call('POST', '/api/devices/demo', { days: 7 }, token);
console.log(`  ${demo.summary}`);
console.log(`  生成行：${demo.rows.map((r) => `${r.date.slice(5)} ${r.steps}步/${r.restingHr}bpm`).join('  ')}`);

line('3. 一周数据 GET /api/devices/daily?days=7');
const daily = await call('GET', '/api/devices/daily?days=7', null, token);
console.log(`  ${daily.list.length} 天；日均步数 ${daily.summary.avgSteps}，日均静息心率 ${daily.summary.avgRestingHr}，日均睡眠 ${daily.summary.avgSleep}h`);
for (const d of daily.list) console.log(`  ${pad(d.date, 12)} ${pad(d.steps + ' 步', 10)} ${pad(d.restingHr + ' bpm', 9)} ${d.sleepHours}h`);

line('4. 文件导入 POST /api/devices/import（先 dryRun 预览）');
const csv = [
  '日期,步数,静息心率,睡眠,体重',
  '2026-10-18,9120,63,7.4,75.4',
  '2026-10-19,10350,62,7.8,75.3',
  '2026/10/20,6400,65,6.5,',
].join('\n');
const pre = await call('POST', '/api/devices/import', { format: 'csv', content: csv, dryRun: true }, token);
console.log(`  预览：解析 ${pre.total} 行，示例 ${JSON.stringify(pre.preview[0])}`);
const imp = await call('POST', '/api/devices/import', { format: 'csv', content: csv, deviceName: '自测 CSV' }, token);
console.log(`  导入：${imp.summary}`);

line('5. 静息心率写入身体数据 POST /api/devices/heart-rate');
const before = await call('GET', '/api/body/analysis', null, token);
const hr = await call(
  'POST',
  '/api/devices/heart-rate',
  { deviceName: '自测心率带', avg: 68, max: 96, min: 58, durationSec: 300, samples: [58, 70, 96, 68], saveAsRestingHr: true },
  token,
);
console.log(`  ${hr.summary}（写入记录 ${hr.recordCount} 条）`);
const after = await call('GET', '/api/body/analysis', null, token);
console.log(`  身体数据最新静息心率：${before.latest?.restingHr} → ${after.latest?.restingHr}`);

line('6. 同步历史 GET /api/devices/history');
const hist = await call('GET', '/api/devices/history', null, token);
hist.slice(0, 6).forEach((h) => console.log(`  ${pad(h.source, 10)} ${pad(h.recordCount + ' 条', 7)} ${h.summary}`));
console.log(`  共 ${hist.length} 条`);

line('7. 步数是否真的变成打卡 GET /api/checkin/logs');
const logs = await call('GET', '/api/checkin/logs?limit=60', null, token);
const fromDevice = (logs.list || logs).filter((l) => /设备|演示/.test(l.note || ''));
console.log(`  设备来源的打卡：${fromDevice.length} 条`);
fromDevice.slice(0, 5).forEach((l) => console.log(`  ${pad(l.logDate, 12)} ${pad(l.exerciseName, 8)} ${l.durationMin}min ${l.calories}kcal  (${l.note})`));

line('8. 异常输入是否被挡住');
for (const bad of [
  { label: '空内容', body: { format: 'csv', content: '' } },
  { label: '乱码 CSV', body: { format: 'csv', content: 'a,b,c\nx,y,z' } },
  { label: '非法心率', body: { avg: 5, max: 5, min: 5, durationSec: 10 } },
]) {
  try {
    const url = bad.label === '非法心率' ? '/api/devices/heart-rate' : '/api/devices/import';
    await call('POST', url, bad.body, token);
    console.log(`  ✗ ${bad.label} 竟然通过了（应被拒绝）`);
  } catch (e) {
    console.log(`  ✓ ${bad.label} 被拒绝：${e.message.replace(/^POST \S+ → \d+ /, '')}`);
  }
}

// ---------------------------------------------------------------- 自动同步（④）
/** 带同步令牌的请求（模拟 iPhone 快捷指令 / health-sync.mjs 的调用方式） */
async function syncCall(method, url, body, syncToken) {
  const res = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(syncToken ? { 'X-Sync-Token': syncToken } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`${method} ${url} → ${res.status} ${json.message || ''}`);
  return json.data;
}

line('9. 自动同步：签发令牌 POST /api/sync/tokens');
const tk = await call('POST', '/api/sync/tokens', { name: '自测·自动同步' }, token);
console.log(`  令牌 ${tk.hint}…（明文只在创建时返回一次）`);
console.log(`  推送地址：${tk.pushUrl}`);

line('10. 令牌鉴权 + 推送 POST /api/sync/push');
const ping = await syncCall('GET', '/api/sync/ping', null, tk.token);
console.log(`  ping：${ping.user} · 令牌备注 ${ping.tokenName}`);
const today = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const testDate = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
// 关键用例：同一天既有 metrics 又有 heartRate，验证「null 不覆盖已有指标」
const pushed = await syncCall(
  'POST',
  '/api/sync/push',
  {
    device: '自测·自动同步',
    date: testDate,
    metrics: { steps: 6789, restingHr: 57, sleepHours: 8.2, weightKg: 74.9 },
    heartRate: { avg: 88, max: 141, min: 62, durationSec: 1200, saveAsRestingHr: false },
  },
  tk.token,
);
console.log(`  ${pushed.summary}`);
const after2 = await call('GET', '/api/devices/daily?days=7', null, token);
const day = after2.list.find((d) => d.date === testDate);
console.log(`  ${testDate} 落库：${day?.steps} 步 / ${day?.restingHr} bpm / ${day?.sleepHours}h（步数与睡眠不应被心率会话清空）`);
if (day?.steps !== 6789) console.log('  ✗ 步数被覆盖了，检查 toCleanRows 的合并逻辑');

line('11. 撤销令牌后应立即失效 DELETE /api/sync/tokens/:id');
await call('DELETE', `/api/sync/tokens/${tk.id}`, null, token);
try {
  await syncCall('GET', '/api/sync/ping', null, tk.token);
  console.log('  ✗ 撤销后仍能推送（应为 401）');
} catch (e) {
  console.log(`  ✓ 已失效：${e.message.replace(/^GET \S+ → \d+ /, '')}`);
}

console.log('\n全部完成');
