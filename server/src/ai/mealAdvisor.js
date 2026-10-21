/**
 * 个性化餐食评估 Agent（份量试算 + 结合身体条件给建议）
 * ===========================================================================
 * 使用场景：用户看完照片识别结果后，填入/调整食物克数，点「AI 分析这一餐」，
 * 系统结合他的身体数据与今日进度，判断这一餐合不合适，并给出可执行的调整建议。
 *
 * 设计遵循本项目一贯的「规则 + 大模型」混合推理：
 *   ① 规则层先算出确定性结论（占目标热量比例、蛋白达成度、是否超出今日额度、
 *      脂肪供能占比、是否缺蔬菜…）——这部分绝不让模型算，避免算错；
 *   ② 大模型只负责把这些结论 + 用户真实数据翻译成自然、有针对性的建议；
 *   ③ 模型不可用时，直接用规则结论拼模板输出（降级），功能不中断。
 *
 * 单餐合理热量区间（占每日目标的比例）参考《中国居民膳食指南》三餐分配：
 *   早餐 20~32% · 午餐 30~42% · 晚餐 22~32% · 加餐 3~12%
 */
import { config } from '../config/index.js';
import { get } from '../db/index.js';
import { chatComplete } from './provider.js';
import { parseJsonLoose } from './validators.js';
import { buildProfile } from './profile.js';
import { logAiCall } from './observability.js';
import { MEAL_ADVICE_PROMPT } from './prompts.js';
import { today } from '../db/index.js';

const MEAL_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

/** 单餐热量占日目标的合理区间 */
const MEAL_RANGE = {
  breakfast: [0.2, 0.32],
  lunch: [0.3, 0.42],
  dinner: [0.22, 0.32],
  snack: [0.03, 0.12],
};

/** 判断食物名是否属于蔬菜类（用于"缺蔬菜"提示，用简单关键词，避免过度工程） */
const VEG_KEYWORDS = ['菜', '蔬', '西兰花', '菠菜', '生菜', '黄瓜', '番茄', '西红柿', '茄子', '豆角', '芦笋', '秋葵', '白菜', '青椒', '胡萝卜', '香菇', '蘑菇', '海带', '豆芽', '紫甘蓝'];

/**
 * 规则层分析：输出确定性结论（不依赖模型）
 * @param {object} p
 * @param {Array} p.items 食物数组 { name, amountG, kcal, protein, fat, carb }
 * @param {object} p.metrics 身体指标（targetCalories / macros）
 * @param {number} p.todayIntake 今日已摄入热量（不含这一餐）
 * @param {string} p.mealType 餐次
 */
export function analyzeMeal({ items, metrics, todayIntake, mealType = 'lunch' }) {
  const sum = (key) => Number(items.reduce((s, i) => s + (Number(i[key]) || 0), 0).toFixed(1));
  const totals = {
    kcal: Math.round(sum('kcal')),
    protein: sum('protein'),
    fat: sum('fat'),
    carb: sum('carb'),
  };

  const targetKcal = metrics.targetCalories || 2000;
  const proteinTarget = metrics.macros.protein || 100;
  const shareOfTarget = Number(((totals.kcal / targetKcal) * 100).toFixed(0));
  const proteinPct = Number(((totals.protein / proteinTarget) * 100).toFixed(0));
  const fatEnergyShare = totals.kcal > 0 ? Number((((totals.fat * 9) / totals.kcal) * 100).toFixed(0)) : 0;
  const remainingAfter = targetKcal - todayIntake - totals.kcal;
  const [lo, hi] = MEAL_RANGE[mealType] || MEAL_RANGE.lunch;

  const flags = [];
  let verdict = 'good';

  if (shareOfTarget < lo * 100) {
    verdict = 'low';
    flags.push(`热量只占今日目标的 ${shareOfTarget}%，低于${MEAL_LABEL[mealType]}建议的 ${Math.round(lo * 100)}~${Math.round(hi * 100)}%，容易饿`);
  } else if (shareOfTarget > hi * 100) {
    verdict = 'high';
    flags.push(`热量占今日目标的 ${shareOfTarget}%，高于${MEAL_LABEL[mealType]}建议的 ${Math.round(lo * 100)}~${Math.round(hi * 100)}%`);
  } else {
    flags.push(`热量占今日目标的 ${shareOfTarget}%，在${MEAL_LABEL[mealType]}合理区间内`);
  }

  if (remainingAfter < 0) flags.push(`吃完这一餐会超出今日额度 ${Math.abs(remainingAfter)} kcal`);
  if (proteinPct < 20) flags.push(`蛋白质 ${totals.protein}g，仅达每日目标的 ${proteinPct}%，偏低`);
  else if (proteinPct > 60) flags.push(`蛋白质 ${totals.protein}g，已达每日目标的 ${proteinPct}%，注意后两餐减量`);
  if (fatEnergyShare > 45) flags.push(`脂肪供能占比 ${fatEnergyShare}%，偏高（建议 20~30%）`);
  if (fatEnergyShare > 0 && fatEnergyShare < 15) flags.push(`脂肪供能仅占 ${fatEnergyShare}%，偏低，可适量补充坚果或橄榄油`);

  const hasVeg = items.some((i) => VEG_KEYWORDS.some((k) => String(i.name || '').includes(k)));
  if (!hasVeg && totals.kcal > 200) flags.push('这一餐没有蔬菜，建议补一份 150~200g 绿叶菜或瓜茄类');

  return {
    totals,
    shareOfTarget,
    proteinPct,
    fatEnergyShare,
    remainingAfter,
    range: [Math.round(lo * 100), Math.round(hi * 100)],
    verdict, // good | high | low
    flags,
    hasVeg,
  };
}

/**
 * 生成个性化饮食建议
 * @param {object} p
 * @param {number} p.userId
 * @param {Array} p.items 食物数组
 * @param {string} p.mealType 餐次
 * @param {string} [p.imageDesc] 图片场景描述（可选，让建议更有上下文）
 */
export async function adviseMeal({ userId, items, mealType = 'lunch', imageDesc = '' }) {
  const start = Date.now();

  // ---------- ① 画像 + 今日进度 ----------
  const { profile, metrics } = buildProfile(userId, {});
  const todayIn = get('SELECT SUM(kcal) AS k FROM diet_logs WHERE user_id = ? AND log_date = ?', [userId, today()]);
  const todayIntake = Math.round(todayIn?.k || 0);

  // ---------- ② 规则层分析（确定性） ----------
  const analysis = analyzeMeal({ items, metrics, todayIntake, mealType });

  const itemLines = items
    .map((i) => `- ${i.name} ${i.amountG}g，约 ${Math.round(i.kcal)} kcal（蛋白 ${i.protein}g / 脂肪 ${i.fat}g / 碳水 ${i.carb}g）`)
    .join('\n');

  const facts = `【用户身体条件】
性别：${profile.genderText}，年龄：${profile.age} 岁，身高：${profile.height} cm，体重：${profile.weight} kg
BMI：${metrics.bmi}（${metrics.bmiLevel}）${profile.bodyFat ? `，体脂率 ${profile.bodyFat}%` : ''}
健身目标：${profile.goalText}
每日目标热量：${metrics.targetCalories} kcal；蛋白质 ${metrics.macros.protein}g / 碳水 ${metrics.macros.carb}g / 脂肪 ${metrics.macros.fat}g
今日已摄入：${todayIntake} kcal（剩余 ${Math.max(0, metrics.targetCalories - todayIntake)} kcal）

【这一餐（${MEAL_LABEL[mealType]}）】
${imageDesc ? `照片场景：${imageDesc}\n` : ''}${itemLines}
合计：${analysis.totals.kcal} kcal（蛋白 ${analysis.totals.protein}g / 脂肪 ${analysis.totals.fat}g / 碳水 ${analysis.totals.carb}g）

【系统规则引擎的确定性结论（必须采用，不得与之矛盾）】
- 热量占今日目标：${analysis.shareOfTarget}%（${MEAL_LABEL[mealType]}合理区间 ${analysis.range[0]}~${analysis.range[1]}%）→ 判定：${{ good: '合适', high: '偏高', low: '偏低' }[analysis.verdict]}
- 蛋白质达成：占每日目标 ${analysis.proteinPct}%
- 脂肪供能占比：${analysis.fatEnergyShare}%
- 吃完后今日剩余：${analysis.remainingAfter} kcal
${analysis.flags.map((f) => `- ${f}`).join('\n')}`;

  // ---------- ③ 大模型生成建议 ----------
  let advice = null;
  let provider = 'fallback';
  let errorMsg = null;

  if (config.ai.enabled) {
    try {
      const res = await chatComplete({
        messages: [
          { role: 'system', content: MEAL_ADVICE_PROMPT },
          { role: 'user', content: `${facts}\n\n请按系统提示的 JSON 结构输出。` },
        ],
        jsonMode: true,
        maxTokens: 1200,
        temperature: 0.5,
      });
      const parsed = parseJsonLoose(res.content);
      if (parsed && parsed.headline) {
        advice = {
          verdict: ['good', 'high', 'low'].includes(parsed.verdict) ? parsed.verdict : analysis.verdict,
          headline: String(parsed.headline).slice(0, 80),
          issues: (Array.isArray(parsed.issues) ? parsed.issues : []).slice(0, 3).map((s) => String(s).slice(0, 80)),
          suggestions: (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).slice(0, 3).map((s) => String(s).slice(0, 100)),
        };
        provider = 'llm';
      } else {
        errorMsg = '模型未返回合法建议结构';
      }
    } catch (err) {
      errorMsg = err.message;
    }
  }

  // ---------- ④ 降级：规则结论拼模板 ----------
  if (!advice) {
    const verdictText = { good: '这一餐搭配基本合适', high: '这一餐热量偏高', low: '这一餐偏少，容易饿' }[analysis.verdict];
    advice = {
      verdict: analysis.verdict,
      headline: `${verdictText}：约 ${analysis.totals.kcal} kcal，占今日目标 ${analysis.shareOfTarget}%`,
      issues: analysis.flags.slice(0, 2),
      suggestions: [
        analysis.remainingAfter < 0
          ? `今天已经超出 ${Math.abs(analysis.remainingAfter)} kcal，剩余时间建议以蔬菜和蛋白为主`
          : `今天还可摄入约 ${analysis.remainingAfter} kcal，下一餐注意控制主食份量`,
        analysis.proteinPct < 20 ? '这一餐蛋白偏低，可以加一个鸡蛋（约 6g 蛋白）或 100g 鸡胸肉' : '蛋白摄入已达标，注意搭配蔬菜补充膳食纤维',
      ],
    };
  }

  logAiCall({
    userId,
    scene: 'meal-advice',
    provider,
    model: provider === 'llm' ? config.ai.model : 'rule-engine-v1',
    latencyMs: Date.now() - start,
    fallback: provider === 'fallback',
    status: 'ok',
    errorMsg,
  });

  return {
    totals: analysis.totals,
    analysis: {
      shareOfTarget: analysis.shareOfTarget,
      proteinPct: analysis.proteinPct,
      fatEnergyShare: analysis.fatEnergyShare,
      remainingAfter: analysis.remainingAfter,
      range: analysis.range,
      verdict: analysis.verdict,
      flags: analysis.flags,
      hasVeg: analysis.hasVeg,
    },
    body: {
      weight: profile.weight,
      bmi: metrics.bmi,
      bmiLevel: metrics.bmiLevel,
      goalText: profile.goalText,
      targetCalories: metrics.targetCalories,
      proteinTarget: metrics.macros.protein,
      todayIntake,
      todayRemaining: Math.max(0, metrics.targetCalories - todayIntake),
    },
    advice,
    meta: { provider, latencyMs: Date.now() - start },
  };
}
