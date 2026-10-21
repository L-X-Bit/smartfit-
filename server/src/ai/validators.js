/**
 * 结构化输出校验与修复（Structured Output Validation）
 * ---------------------------------------------------------------------------
 * 大模型输出 JSON 的常见问题：
 *   ① 用 ```json 代码块包裹；② 前后带解释文字；③ 字段缺失；④ 类型不对；
 *   ⑤ 编造知识库里没有的 exerciseId；⑥ 数值超出合理范围（如 sets=20）。
 * 本模块做三层防御：
 *   1. parseJsonLoose —— 容错解析（剥代码块、截取首个 { 到最后一个 }）
 *   2. validatePlan / validateDiet —— 结构校验 + 归一化（修正而非直接失败）
 *   3. 归一化后再交给上层；若仍不可用 → 上层触发「修复重试」或「规则引擎降级」
 * 这种「校验 + 修复 + 降级」三级策略是保证 AI 功能在生产环境可用的关键。
 */

/** 从模型回复中尽量解析出 JSON 对象 */
export function parseJsonLoose(text = '') {
  if (!text) return null;
  let s = String(text).trim();

  // ① 剥离 markdown 代码块
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // ② 截取首个 { 或 [ 到最后一个 } 或 ]
  const startObj = s.indexOf('{');
  const startArr = s.indexOf('[');
  const start = startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
  if (start > 0) s = s.slice(start);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (end !== -1 && end < s.length - 1) s = s.slice(0, end + 1);

  try {
    return JSON.parse(s);
  } catch {
    // ③ 常见修复：去掉尾随逗号
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** 把任意输入收敛为整数并夹在范围内 */
const clampInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/** 把次数统一成字符串（"12" / "8-12" / "40 秒"） */
const normalizeReps = (v) => {
  if (v === undefined || v === null || v === '') return '10';
  if (typeof v === 'number') return String(v);
  return String(v).slice(0, 20);
};

/**
 * 校验并归一化训练计划
 * @param {any} raw 模型输出的对象
 * @param {object} opts
 * @param {Map<string, any>} opts.exerciseMap 知识库动作映射（id → 动作），用于拦截编造
 * @param {number} opts.weeks 期望周数
 * @returns {{ ok: boolean, plan: any, errors: string[], repaired: number }}
 */
export function validatePlan(raw, { exerciseMap, weeks = 4, daysPerWeek = 3 }) {
  const errors = [];
  let repaired = 0;
  const repair = (msg) => {
    repaired += 1;
    if (repaired <= 5) errors.push(msg);
  };

  if (!raw || typeof raw !== 'object') {
    return { ok: false, plan: null, errors: ['模型输出不是合法 JSON 对象'], repaired: 0 };
  }

  // ---- 顶层字段
  const plan = {
    title: String(raw.title || 'AI 定制训练计划').slice(0, 40),
    goal: ['lose', 'gain', 'keep', 'shape'].includes(raw.goal) ? raw.goal : undefined,
    level: ['beginner', 'intermediate', 'advanced'].includes(raw.level) ? raw.level : 'beginner',
    weeks: clampInt(raw.weeks, 1, 12, weeks),
    daysPerWeek: clampInt(raw.daysPerWeek, 1, 7, daysPerWeek),
    summary: String(raw.summary || '').slice(0, 600),
    nutritionTips: String(raw.nutritionTips || '').slice(0, 600),
    safetyNotes: Array.isArray(raw.safetyNotes) ? raw.safetyNotes.slice(0, 5).map((s) => String(s).slice(0, 120)) : [],
    weeklySchedule: [],
  };
  if (!plan.summary) repair('缺少 summary 字段，已用默认描述补齐');
  if (!plan.nutritionTips) repair('缺少 nutritionTips，已置空');

  // ---- 日程
  const schedule = Array.isArray(raw.weeklySchedule) ? raw.weeklySchedule : [];
  if (!schedule.length) {
    return { ok: false, plan, errors: ['weeklySchedule 为空'], repaired };
  }

  let dropped = 0;
  for (const day of schedule) {
    const items = Array.isArray(day?.items) ? day.items : [];
    const cleanItems = [];
    for (const item of items) {
      // 关键：拦截编造动作——只接受知识库中真实存在的 exerciseId
      // 若 id 不存在则尝试按名称模糊匹配（模型有时会返回正确名字但 id 写错）
      let ex = exerciseMap.get(item?.exerciseId);
      if (!ex && item?.name) {
        ex = [...exerciseMap.values()].find((e) => e.name === item.name || e.name.includes(String(item.name).slice(0, 2)));
      }
      if (!ex) {
        dropped += 1;
        continue;
      }
      cleanItems.push({
        exerciseId: ex.id,
        exerciseName: ex.name,
        targetGroup: String(item?.targetGroup || ex.muscleGroup).slice(0, 12),
        sets: clampInt(item?.sets, 0, 8, 3),
        reps: normalizeReps(item?.reps),
        restSec: clampInt(item?.restSec, 0, 300, 60),
        durationMin: clampInt(item?.durationMin, 0, 120, 0),
        note: String(item?.note || '').slice(0, 100),
      });
    }
    if (dropped > 0) repair(`剔除了 ${dropped} 个知识库中不存在的动作（防幻觉）`);
    if (!cleanItems.length) continue;

    plan.weeklySchedule.push({
      week: clampInt(day?.week, 1, plan.weeks, 1),
      day: clampInt(day?.day, 1, 7, 1),
      focus: String(day?.focus || '综合训练').slice(0, 20),
      items: cleanItems,
    });
  }

  if (!plan.weeklySchedule.length) {
    return { ok: false, plan, errors: [...errors, '没有任何有效训练日'], repaired };
  }

  // ---- 周次完整性检查（不足则复制最后一周并递进，保证 4 周都可用）
  const weekSet = new Set(plan.weeklySchedule.map((d) => d.week));
  if (weekSet.size < plan.weeks) {
    repair(`模型只生成了 ${weekSet.size} 周，已按渐进超负荷补全至 ${plan.weeks} 周`);
    const lastWeek = Math.max(...weekSet);
    const template = plan.weeklySchedule.filter((d) => d.week === lastWeek);
    for (let w = lastWeek + 1; w <= plan.weeks; w += 1) {
      for (const d of template) {
        plan.weeklySchedule.push({
          ...d,
          week: w,
          items: d.items.map((it) => ({ ...it, note: it.note || `第 ${w} 周：次数或重量较上周提升 5%` })),
        });
      }
    }
  }

  plan.weeklySchedule.sort((a, b) => a.week - b.week || a.day - b.day);
  return { ok: true, plan, errors, repaired };
}

/**
 * 校验饮食方案
 */
export function validateDiet(raw, { foodMap }) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.meals)) {
    return { ok: false, diet: null, errors: ['饮食方案结构不合法'] };
  }
  const mealNameMap = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
  const meals = [];
  for (const m of raw.meals) {
    const items = (Array.isArray(m?.items) ? m.items : [])
      .map((it) => {
        const food = foodMap.get(String(it?.foodName || ''));
        if (!food) return null; // 只允许引用食物库中的食物
        const amountG = clampInt(it.amountG, 10, 800, 100);
        const k = amountG / 100;
        return {
          foodId: food.id,
          foodName: food.name,
          amountG,
          kcal: Math.round(food.kcal * k),
          protein: Number((food.protein * k).toFixed(1)),
          fat: Number((food.fat * k).toFixed(1)),
          carb: Number((food.carb * k).toFixed(1)),
        };
      })
      .filter(Boolean);
    if (!items.length) continue;
    const mealType = Object.keys(mealNameMap).includes(m?.mealType) ? m.mealType : 'lunch';
    meals.push({ mealType, mealName: mealNameMap[mealType], items });
  }
  if (!meals.length) return { ok: false, diet: null, errors: ['没有识别到任何可用食物'] };

  const sum = (key) => Math.round(meals.reduce((s, m) => s + m.items.reduce((a, i) => a + i[key], 0), 0));
  return {
    ok: true,
    diet: {
      summary: String(raw.summary || '').slice(0, 300),
      meals,
      totalKcal: sum('kcal'),
      totalProtein: sum('protein'),
      totalFat: sum('fat'),
      totalCarb: sum('carb'),
      tips: Array.isArray(raw.tips) ? raw.tips.slice(0, 5).map((t) => String(t).slice(0, 100)) : [],
    },
    errors: [],
  };
}
