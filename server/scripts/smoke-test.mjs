// 第二轮冒烟测试：POST/PATCH 类接口 + SSE 流式
(async () => {
  const base = 'http://localhost:3000';
  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: '123456' }),
  })).json();
  const H = { Authorization: 'Bearer ' + login.data.token, 'Content-Type': 'application/json' };
  const call = async (url, method, body) => {
    const r = await fetch(base + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let b;
    try { b = JSON.parse(t); } catch { b = t.slice(0, 300); }
    return { status: r.status, b };
  };

  // 1. AI 生成计划（无 Key 时应走规则引擎）
  const t0 = Date.now();
  const plan = await call('/api/plan/generate', 'POST', { goal: 'lose', daysPerWeek: 4, weeks: 4, sessionMinutes: 45, level: 'beginner', equipment: ['徒手', '哑铃'], conditions: ['knee'] });
  console.log('plan/generate ->', plan.status, 'elapsed', Date.now() - t0, 'ms');
  console.log('  title:', plan.b?.data?.plan?.title, '| source:', plan.b?.data?.plan?.source, '| weeks:', plan.b?.data?.plan?.weeklySchedule?.length);
  console.log('  stages:', (plan.b?.data?.meta?.stages || []).map((s) => `${s.stage}(${s.ms}ms)`).join(', '));
  console.log('  refs:', (plan.b?.data?.refs || []).length, '| audit:', JSON.stringify(plan.b?.data?.meta?.audit));
  const planId = plan.b?.data?.planId;

  // 2. 计划详情 + 勾选动作（自动打卡）
  const detail = await call('/api/plan/' + planId, 'GET');
  const firstItem = detail.b?.data?.weeklySchedule?.[0]?.days?.[0]?.items?.[0];
  console.log('plan detail ->', detail.status, '| first item:', firstItem?.exercise_name, '| total weeks:', detail.b?.data?.weeklySchedule?.length);
  const toggle = await call('/api/plan/items/' + firstItem?.id, 'PATCH', { done: true, autoCheckin: true });
  console.log('toggle item ->', toggle.status, JSON.stringify(toggle.b?.data?.progress), '| checkin:', toggle.b?.data?.checkin?.exercise_name);

  // 3. 打卡
  const checkin = await call('/api/checkin/logs', 'POST', { exerciseId: 'ex_squat_bw', exerciseName: '徒手深蹲', durationMin: 20, intensity: 'medium', sets: 3, reps: 15, feeling: '适中', note: '冒烟测试' });
  console.log('checkin ->', checkin.status, checkin.b?.data?.calories, 'kcal');

  // 4. 身体数据
  const body = await call('/api/body/records', 'POST', { weightKg: 75.1, bodyFat: 19.0, muscleKg: 34.7, waistCm: 82.5, restingHr: 64, sleepHours: 7.2, note: '冒烟测试' });
  console.log('body record ->', body.status, body.b?.data?.weightKg);

  // 5. 饮食：AI 配餐 + 一键采纳
  const rec = await call('/api/diet/recommend', 'POST', {});
  console.log('diet recommend ->', rec.status, '| provider:', rec.b?.data?.meta?.provider, '| totalKcal:', rec.b?.data?.diet?.totalKcal, '| deviation:', rec.b?.data?.diet?.kcalDeviation + '%');
  if (rec.b?.data?.diet?.meals) {
    const batch = await call('/api/diet/logs/batch', 'POST', {
      meals: rec.b.data.diet.meals.map((m) => ({ mealType: m.mealType, items: m.items.map((i) => ({ foodId: i.foodId, amountG: i.amountG })) })),
    });
    console.log('diet batch ->', batch.status, batch.b?.data?.count, 'items');
  }

  // 6. 社区：发帖 + 点赞 + 评论
  const post = await call('/api/community/posts', 'POST', { content: '冒烟测试：今天完成了 AI 计划的第一天训练！', topic: '减脂日记', images: [] });
  console.log('create post ->', post.status, '| id:', post.b?.data?.id);
  if (post.b?.data?.id) {
    const like = await call('/api/community/posts/' + post.b.data.id + '/like', 'POST');
    const comment = await call('/api/community/posts/' + post.b.data.id + '/comments', 'POST', { content: '继续保持！' });
    console.log('like ->', like.status, like.b?.data?.likeCount, '| comment ->', comment.status, comment.b?.data?.commentCount);
    await call('/api/community/posts/' + post.b.data.id, 'DELETE');
  }

  // 7. 图片上传
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFvp5FpAAAAAElFTkSuQmCC';
  const up = await call('/api/ai/upload', 'POST', { dataUrl: png1x1 });
  console.log('upload ->', up.status, up.b?.data?.url);

  // 8. SSE 流式对话
  const res = await fetch(base + '/api/ai/coach', { method: 'POST', headers: H, body: JSON.stringify({ question: '我膝盖有旧伤，想减脂，怎么安排训练？' }) });
  const text = await res.text();
  const deltas = text.split('\n\n').filter((f) => f.includes('event: delta')).length;
  const doneFrame = text.split('\n\n').find((f) => f.includes('event: done'));
  console.log('coach SSE ->', res.status, '| delta frames:', deltas, '| has done:', Boolean(doneFrame));
  console.log('  answer head:', text.split('data: ')[1]?.slice(0, 120));

  // 9. AI 统计
  const stats = await call('/api/ai/stats', 'GET');
  console.log('ai stats ->', stats.status, JSON.stringify(stats.b?.data?.byScene));
})();
