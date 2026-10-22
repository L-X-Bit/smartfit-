/**
 * 设备同步接口自测脚本
 * ===========================================================================
 * 用法：node tools/test-devices.mjs
 * 覆盖：status / demo（生成 7 天）/ daily / history / import（预览 + 真实导入）/ heart-rate
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

console.log('\n全部完成');
