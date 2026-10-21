/**
 * 饮食配比 Agent（结构化输出 + 热量对齐校验）
 * ---------------------------------------------------------------------------
 * 业务闭环：身体数据 → 目标热量 → 一日餐单 → 一键写入饮食记录
 * 技术要点：
 *   ① 目标热量与三大营养素由规则引擎算出（不让模型算数）；
 *   ② RAG 只喂「食物营养库」，模型只能从库中选食物，杜绝编造食物与编造营养值；
 *   ③ 输出后用 validateDiet 重新按库内数据重算热量（模型算错也没关系，以库为准）；
 *   ④ 无 Key / 失败时降级为「贪心配餐算法」，同样对齐目标热量。
 */
import { all, get } from '../db/index.js';
import { config } from '../config/index.js';
import { chatComplete } from './provider.js';
import { DIET_SYSTEM_PROMPT } from './prompts.js';
import { retrieveFoods, buildContext } from './rag.js';
import { parseJsonLoose, validateDiet } from './validators.js';
import { buildProfile } from './profile.js';
import { logAiCall } from './observability.js';
import { cacheGet, cacheSet, fingerprint } from './cache.js';

/** 三餐热量分配比例 */
const MEAL_RATIO = [
  { mealType: 'breakfast', mealName: '早餐', ratio: 0.3 },
  { mealType: 'lunch', mealName: '午餐', ratio: 0.4 },
  { mealType: 'dinner', mealName: '晚餐', ratio: 0.25 },
  { mealType: 'snack', mealName: '加餐', ratio: 0.05 },
];

/**
 * 降级配餐算法（贪心）
 * 思路：每餐按目标热量从食物库中挑「蛋白优先 + 体积合理」的组合，
 * 份量按 100g 的倍数缩放，最后统计总量并给出提示。
 */
function buildFallbackDiet({ metrics, goal }) {
  const foods = all('SELECT * FROM foods');
  const byId = new Map(foods.map((f) => [f.id, f]));

  /** 每餐的候选策略：蛋白 + 主食 + 蔬果 */
  const strategies = {
    breakfast: [
      { ids: ['fd_oats', 'fd_egg', 'fd_milk'], shares: [0.35, 0.35, 0.3] },
      { ids: ['fd_whole_bread', 'fd_egg_white', 'fd_banana'], shares: [0.4, 0.3, 0.3] },
    ],
    lunch: [
      { ids: ['fd_rice', 'fd_chicken_breast', 'fd_broccoli'], shares: [0.45, 0.35, 0.2] },
      { ids: ['fd_brown_rice', 'fd_beef_lean', 'fd_spinach'], shares: [0.45, 0.35, 0.2] },
    ],
    dinner: [
      { ids: ['fd_sweet_potato', 'fd_basa', 'fd_asparagus'], shares: [0.4, 0.4, 0.2] },
      { ids: ['fd_quinoa', 'fd_shrimp', 'fd_cucumber'], shares: [0.4, 0.4, 0.2] },
    ],
    snack: [{ ids: ['fd_greek_yogurt', 'fd_blueberry'], shares: [0.7, 0.3] }],
  };

  const meals = [];
  for (const meal of MEAL_RATIO) {
    const targetKcal = metrics.targetCalories * meal.ratio;
    const strat = strategies[meal.mealType][0];
    const items = [];
    strat.ids.forEach((id, idx) => {
      const food = byId.get(id);
      if (!food) return;
      const kcalForItem = targetKcal * strat.shares[idx];
      // amount = 目标热量 / 每克热量，按 10g 取整，限制在 10~400g
      const amountG = Math.min(400, Math.max(10, Math.round((kcalForItem / food.kcal) * 100 / 10) * 10));
      const k = amountG / 100;
      items.push({
        foodId: food.id,
        foodName: food.name,
        amountG,
        kcal: Math.round(food.kcal * k),
        protein: Number((food.protein * k).toFixed(1)),
        fat: Number((food.fat * k).toFixed(1)),
        carb: Number((food.carb * k).toFixed(1)),
      });
    });
    meals.push({ mealType: meal.mealType, mealName: meal.mealName, items });
  }

  const sum = (key) => Math.round(meals.reduce((s, m) => s + m.items.reduce((a, i) => a + i[key], 0), 0));
  return {
    summary: `按你每日 ${metrics.targetCalories} kcal 的目标，采用「高蛋白 + 中低碳水 + 适量好脂肪」的思路配餐，三餐比例 3:4:3，训练日可把加餐放在训练后。`,
    meals,
    totalKcal: sum('kcal'),
    totalProtein: sum('protein'),
    totalFat: sum('fat'),
    totalCarb: sum('carb'),
    tips: [
      `蛋白质目标 ${metrics.macros.protein}g，优先分配到三餐，每餐 25~40g`,
      '烹饪方式以蒸、煮、烤、少油快炒为主，避免油炸',
      '每天饮水 2000ml 以上，训练日额外补充 500ml',
    ],
    _engine: 'fallback',
  };
}

/**
 * 生成一日饮食方案
 * @param {object} p
 * @param {number} p.userId
 * @param {'lose'|'gain'|'keep'|'shape'} [p.goal]
 */
export async function generateDiet({ userId, goal }) {
  const start = Date.now();
  const { profile, metrics } = buildProfile(userId, { goal });
  const foodMap = new Map(all('SELECT * FROM foods').map((f) => [f.name, f]));

  // ---------- RAG：检索高蛋白/减脂相关食物作为候选，约束模型选择范围 ----------
  const ragQuery = {
    lose: '高蛋白 低脂 饱腹 减脂 鸡胸 燕麦 蔬菜',
    gain: '高蛋白 增肌 碳水 牛肉 米饭 蛋',
    shape: '高蛋白 低脂 塑形 鱼 虾 蔬菜',
    keep: '均衡 主食 蛋白 蔬菜 水果',
  }[profile.goal] || '均衡 蛋白 蔬菜';
  const candidateFoods = retrieveFoods({ query: ragQuery, topK: 18 });
  const { text: contextText, refs } = buildContext({ foods: candidateFoods });

  const cacheKey = `diet:${userId}:${fingerprint({ goal: profile.goal, kcal: metrics.targetCalories, weight: profile.weight })}`;
  if (config.aiCacheEnabled) {
    const cached = cacheGet(cacheKey);
    if (cached.hit) {
      logAiCall({ userId, scene: 'diet', provider: 'cache', latencyMs: Date.now() - start, cacheHit: true, ragHits: refs.length });
      // 注意：缓存命中分支也必须返回完整的 meta，否则上层读取 result.meta.fallback 会抛错
      return {
        diet: { ...cached.value, autoScaled: cached.value.autoScaled ?? false, cacheHit: true },
        refs,
        meta: {
          provider: 'cache',
          model: 'cached',
          fallback: false,
          cacheHit: true,
          deviation: cached.value.kcalDeviation,
          autoScaled: cached.value.autoScaled ?? false,
        },
      };
    }
  }

  let diet = null;
  let provider = 'fallback';
  let model = 'greedy-engine-v1';
  let fallback = false;
  let errorMsg = null;

  if (config.ai.enabled) {
    try {
      const res = await chatComplete({
        messages: [
          { role: 'system', content: DIET_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `【用户目标】每日 ${metrics.targetCalories} kcal；蛋白质 ${metrics.macros.protein}g、碳水 ${metrics.macros.carb}g、脂肪 ${metrics.macros.fat}g；目标：${profile.goalText}；体重 ${profile.weight}kg。\n\n${contextText}\n\n请生成一日餐单 JSON。`,
          },
        ],
        jsonMode: true,
        maxTokens: 2200,
        temperature: 0.4,
      });
      const v = validateDiet(parseJsonLoose(res.content), { foodMap });
      if (v.ok) {
        diet = v.diet;
        provider = 'llm';
        model = res.model;
      } else {
        errorMsg = v.errors.join('；');
      }
    } catch (err) {
      errorMsg = err.message;
    }
  }

  if (!diet) {
    diet = buildFallbackDiet({ metrics, goal: profile.goal });
    fallback = config.ai.enabled;
  }

  // ---------- 份量自动校正（确定性兜底）----------
  // 实测：大模型偶尔把份量给得偏小（目标 2255 kcal 只配到 1373 kcal，偏差 −39%）。
  // 这里以食物库为准按比例缩放每份克数，再重新换算营养值，保证方案落地即达标。
  const scaleResult = rescaleDietToTarget(diet, metrics.targetCalories);

  // ---------- 热量对齐校验：以食物库数据为准重新计算，并给出偏差 ----------
  const diff = diet.totalKcal - metrics.targetCalories;
  diet.targetKcal = metrics.targetCalories;
  diet.targetProtein = metrics.macros.protein;
  diet.kcalDiff = diff;
  diet.kcalDeviation = Number(((diff / metrics.targetCalories) * 100).toFixed(1));
  diet.inRange = Math.abs(diet.kcalDeviation) <= 8; // 误差 ±8% 视为达标
  diet.autoScaled = scaleResult.scaled;             // 是否做了份量校正（前端会提示）
  diet.scaleFactor = scaleResult.factor;

  // ---------- 蛋白质偏离提示（模型倾向于给"高蛋白"，如实告知用户，而不是藏起来）----------
  const proteinTarget = metrics.macros.protein;
  if (proteinTarget && diet.totalProtein > proteinTarget * 1.25) {
    diet.tips = [
      ...(diet.tips || []),
      `本方案蛋白质 ${diet.totalProtein}g，高于目标 ${proteinTarget}g，可把部分肉类换成蔬菜，或少吃一个蛋。`,
    ];
  }

  if (config.aiCacheEnabled) cacheSet(cacheKey, diet);

  logAiCall({
    userId,
    scene: 'diet',
    provider,
    model,
    latencyMs: Date.now() - start,
    fallback,
    ragHits: refs.length,
    status: fallback ? 'error' : 'ok',
    errorMsg,
  });

  return {
    diet,
    refs,
    meta: { provider, model, fallback, deviation: diet.kcalDeviation, autoScaled: diet.autoScaled, scaleFactor: diet.scaleFactor },
  };
}

/**
 * 份量自动校正：把全天总热量按比例拉回目标值
 * @param {object} diet validateDiet 产出的方案（包含 meals[].items[].foodId / amountG）
 * @param {number} targetKcal 目标热量
 * @returns {{scaled: boolean, factor: number}}
 */
function rescaleDietToTarget(diet, targetKcal) {
  if (!diet?.totalKcal || !diet.meals?.length) return { scaled: false, factor: 1 };

  const factor = targetKcal / diet.totalKcal;
  // 偏差已在 ±8% 内则不动，避免来回改动
  if (Math.abs(factor - 1) <= 0.08) return { scaled: false, factor: 1 };

  for (const meal of diet.meals) {
    for (const it of meal.items) {
      const food = it.foodId ? get('SELECT * FROM foods WHERE id = ?', [it.foodId]) : get('SELECT * FROM foods WHERE name = ?', [it.foodName]);
      if (!food) continue;
      // 按 5g 取整，并限制单份 10~600g（避免出现 8g 或 900g 这类不合理份量）
      const amountG = Math.min(600, Math.max(10, Math.round((it.amountG * factor) / 5) * 5));
      const k = amountG / 100;
      it.foodId = food.id;
      it.foodName = food.name;
      it.amountG = amountG;
      it.kcal = Math.round(food.kcal * k);
      it.protein = Number((food.protein * k).toFixed(1));
      it.fat = Number((food.fat * k).toFixed(1));
      it.carb = Number((food.carb * k).toFixed(1));
    }
  }

  const sum = (key) => Math.round(diet.meals.reduce((s, m) => s + m.items.reduce((a, i) => a + i[key], 0), 0));
  diet.totalKcal = sum('kcal');
  diet.totalProtein = sum('protein');
  diet.totalFat = sum('fat');
  diet.totalCarb = sum('carb');
  return { scaled: true, factor: Number(factor.toFixed(2)) };
}

/**
 * 记录一餐（把 AI 餐单或手动选择写入 diet_logs）
 * @param {number} userId
 * @param {string} date
 * @param {string} mealType
 * @param {Array<{foodId?:string, foodName:string, amountG:number}>} items
 */
export function logMeal(userId, date, mealType, items) {
  const rows = [];
  for (const it of items) {
    const food = it.foodId ? get('SELECT * FROM foods WHERE id = ?', [it.foodId]) : get('SELECT * FROM foods WHERE name = ?', [it.foodName]);
    if (!food) continue;
    const k = (Number(it.amountG) || 100) / 100;
    rows.push([
      userId,
      date,
      mealType,
      food.id,
      food.name,
      Number(it.amountG) || 100,
      Math.round(food.kcal * k),
      Number((food.protein * k).toFixed(1)),
      Number((food.fat * k).toFixed(1)),
      Number((food.carb * k).toFixed(1)),
    ]);
  }
  return rows;
}
