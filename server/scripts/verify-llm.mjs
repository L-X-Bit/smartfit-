/**
 * 真实大模型链路验证脚本
 * ---------------------------------------------------------------------------
 * 验证三件事：
 *   1. 训练计划生成走的是真模型（provider=llm），且输出通过结构校验
 *   2. AI 教练走的是流式真模型（逐 token 到达，provider=llm）
 *   3. AI 配餐走的是真模型，且热量对齐校验生效
 * 同时打印耗时、RAG 命中、各阶段信息，用于确认流水线健康。
 */
const BASE = 'http://127.0.0.1:3000';

const post = async (url, body, token) => {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 500) }; }
};

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: '123456' }),
  })).json();
  const token = login.data.token;

  // ==================== 1. 真实大模型生成训练计划 ====================
  console.log('\n========== ① 训练计划（真实大模型）==========');
  const t0 = Date.now();
  const plan = await post('/api/plan/generate', {
    goal: 'lose', daysPerWeek: 4, weeks: 4, sessionMinutes: 45,
    level: 'beginner', equipment: ['徒手', '哑铃'], conditions: ['knee'],
    queryText: '想重点练臀腿，不喜欢跑步，只能在家练',
  }, token);
  const elapsed = Date.now() - t0;
  console.log(`HTTP ${plan.status} | 总耗时 ${(elapsed / 1000).toFixed(1)}s`);

  const d = plan.body?.data;
  if (!d) { console.log('返回异常:', JSON.stringify(plan.body).slice(0, 600)); process.exit(1); }

  console.log(`来源: ${d.plan.source} | provider: ${d.meta.provider} | model: ${d.meta.model}`);
  console.log(`大模型耗时: ${d.meta.llmLatencyMs}ms | 重试: ${d.meta.retryCount} | RAG 命中: ${d.meta.ragHits}`);
  console.log('流水线阶段:');
  for (const s of d.meta.stages || []) console.log(`   - ${s.stage.padEnd(16)} ${String(s.ms).padStart(6)}ms  ${s.note}`);
  console.log(`计划标题: ${d.plan.title}`);
  console.log(`周数: ${d.plan.weeklySchedule.length} | 动作总数: ${d.plan.progress.total}`);
  console.log(`\n总述(${d.plan.summary.length} 字):\n  ${d.plan.summary.slice(0, 220)}...`);
  console.log(`\n饮食建议:\n  ${(d.plan.nutritionTips || '').slice(0, 200)}`);

  const day1 = d.plan.weeklySchedule[0]?.days?.[0];
  console.log(`\n第 1 周第 ${day1?.day} 天（${day1?.focus}）:`);
  for (const it of day1?.items || []) {
    console.log(`   · ${it.exercise_name.padEnd(14)} ${it.sets}组 × ${it.reps}  休息${it.rest_sec}s  ${it.note ? '｜' + it.note.slice(0, 30) : ''}`);
  }
  console.log(`\n安全审核: 移除 ${d.meta.audit.removed} 个禁忌动作`);
  if (d.meta.audit.notes?.length) d.meta.audit.notes.forEach((n) => console.log('   ! ' + n));
  if (d.meta.validationErrors?.length) console.log('校验提示:', d.meta.validationErrors.join('；'));
  console.log(`RAG 引用 (${d.refs.length} 条): ` + d.refs.slice(0, 8).map((r) => r.title).join('、'));

  // ==================== 2. AI 教练流式对话 ====================
  console.log('\n========== ② AI 教练（SSE 流式真实大模型）==========');
  const tc = Date.now();
  const res = await fetch(BASE + '/api/ai/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question: '我膝盖有旧伤，想减脂但不想跑步，一周只有三天能练，怎么安排？' }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  let frames = 0;
  let firstDeltaMs = 0;
  let doneInfo = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const frame of parts) {
      let ev = 'message', data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let p; try { p = JSON.parse(data); } catch { continue; }
      if (ev === 'delta') { if (!firstDeltaMs) firstDeltaMs = Date.now() - tc; frames += 1; answer += p.text || ''; }
      if (ev === 'done') doneInfo = p;
      if (ev === 'error') console.log('SSE 错误:', p.message);
    }
  }
  console.log(`首字延迟: ${firstDeltaMs}ms | 总耗时: ${((Date.now() - tc) / 1000).toFixed(1)}s | 增量帧: ${frames}`);
  console.log(`provider: ${doneInfo?.provider} | 引用: ${(doneInfo?.refs || []).map((r) => r.title).join('、')}`);
  console.log(`\n回答（${answer.length} 字）:\n${answer.slice(0, 700)}${answer.length > 700 ? '\n...(截断)' : ''}`);

  // ==================== 3. AI 配餐 ====================
  console.log('\n========== ③ AI 一日配餐（真实大模型）==========');
  const td = Date.now();
  const diet = await post('/api/diet/recommend', {}, token);
  console.log(`HTTP ${diet.status} | 耗时 ${((Date.now() - td) / 1000).toFixed(1)}s | provider: ${diet.body?.data?.meta?.provider}`);
  const dd = diet.body?.data?.diet;
  if (dd) {
    console.log(`目标 ${dd.targetKcal} kcal | 方案 ${dd.totalKcal} kcal | 偏差 ${dd.kcalDeviation}% ${dd.inRange ? '（达标 ✓）' : '（超范围）'}`);
    console.log(`蛋白 ${dd.totalProtein}g / 脂肪 ${dd.totalFat}g / 碳水 ${dd.totalCarb}g`);
    console.log('配餐思路:', (dd.summary || '').slice(0, 160));
    for (const m of dd.meals || []) {
      console.log(`  ${m.mealName}: ` + m.items.map((i) => `${i.foodName} ${i.amountG}g(${i.kcal}kcal)`).join('、'));
    }
  }

  // ==================== 4. AI 统计 ====================
  console.log('\n========== ④ AI 运行统计 ==========');
  const stats = await (await fetch(BASE + '/api/ai/stats', { headers: { Authorization: `Bearer ${token}` } })).json();
  console.log(`总调用 ${stats.data.totalCalls} | 平均耗时 ${stats.data.avgLatencyMs}ms | 缓存命中率 ${(stats.data.cacheHitRate * 100).toFixed(0)}% | 降级率 ${(stats.data.fallbackRate * 100).toFixed(0)}%`);
  for (const s of stats.data.byScene) {
    console.log(`  ${s.scene.padEnd(6)} 调用${String(s.total).padStart(3)} 平均${String(s.avgLatencyMs).padStart(6)}ms 缓存${s.cached} 降级${s.fallback} RAG${s.ragHits}`);
  }
})();
