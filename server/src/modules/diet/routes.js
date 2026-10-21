/**
 * 健康饮食路由
 * ---------------------------------------------------------------------------
 * GET    /api/diet/foods?kw=&category=     食物库检索
 * GET    /api/diet/summary?date=           某日饮食汇总（含营养素配比、目标对比）
 * POST   /api/diet/logs                    记录一条食物
 * POST   /api/diet/logs/batch              批量记录（AI 餐单「一键采纳」用）
 * DELETE /api/diet/logs/:id                删除
 * POST   /api/diet/recommend               AI 生成一日饮食方案（含热量对齐校验）
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { all, get, run, today } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/common.js';
import { generateDiet } from '../../ai/dietAgent.js';
import { buildProfile } from '../../ai/profile.js';

const router = Router();
router.use(requireAuth);

const MEALS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

/** 食物检索 */
router.get(
  '/foods',
  asyncHandler((req, res) => {
    const { kw, category } = req.query;
    const where = [];
    const params = [];
    if (kw) {
      where.push('(name LIKE ? OR search_text LIKE ?)');
      params.push(`%${kw}%`, `%${kw}%`);
    }
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    const rows = all(
      `SELECT * FROM foods ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY category, kcal DESC LIMIT 200`,
      params,
    );
    return ok(res, rows);
  }),
);

/**
 * 某日饮食汇总：按餐分组 + 全天合计 + 目标对比 + 三大营养素供能比
 */
router.get(
  '/summary',
  asyncHandler((req, res) => {
    const date = req.query.date || today();
    const rows = all('SELECT * FROM diet_logs WHERE user_id = ? AND log_date = ? ORDER BY id', [req.user.id, date]);
    const { metrics, profile } = buildProfile(req.user.id, {});

    const sum = { kcal: 0, protein: 0, fat: 0, carb: 0 };
    const meals = Object.entries(MEALS).map(([type, name]) => {
      const items = rows.filter((r) => r.meal_type === type);
      const kcal = Math.round(items.reduce((s, r) => s + r.kcal, 0));
      const protein = Number(items.reduce((s, r) => s + r.protein, 0).toFixed(1));
      const fat = Number(items.reduce((s, r) => s + r.fat, 0).toFixed(1));
      const carb = Number(items.reduce((s, r) => s + r.carb, 0).toFixed(1));
      sum.kcal += kcal;
      sum.protein += protein;
      sum.fat += fat;
      sum.carb += carb;
      return { mealType: type, mealName: name, kcal, protein, fat, carb, items };
    });

    // 供能比（蛋白 4kcal/g、碳水 4、脂肪 9）
    const energy = {
      protein: Math.round(sum.protein * 4),
      carb: Math.round(sum.carb * 4),
      fat: Math.round(sum.fat * 9),
    };
    const energyTotal = energy.protein + energy.carb + energy.fat || 1;
    const ratio = {
      protein: Number(((energy.protein / energyTotal) * 100).toFixed(1)),
      carb: Number(((energy.carb / energyTotal) * 100).toFixed(1)),
      fat: Number(((energy.fat / energyTotal) * 100).toFixed(1)),
    };

    return ok(res, {
      date,
      meals,
      totals: {
        kcal: Math.round(sum.kcal),
        protein: Number(sum.protein.toFixed(1)),
        fat: Number(sum.fat.toFixed(1)),
        carb: Number(sum.carb.toFixed(1)),
      },
      target: {
        kcal: metrics.targetCalories,
        protein: metrics.macros.protein,
        fat: metrics.macros.fat,
        carb: metrics.macros.carb,
      },
      ratio,
      remaining: {
        kcal: metrics.targetCalories - Math.round(sum.kcal),
        protein: Number((metrics.macros.protein - sum.protein).toFixed(1)),
      },
      profile: { goal: profile.goal, goalText: profile.goalText, weight: profile.weight },
    });
  }),
);

/** 记录一条食物 */
const logSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
  foodId: z.string().min(1, '请选择食物'),
  amountG: z.number().min(1, '份量至少 1g').max(2000, '份量过大'),
});

router.post(
  '/logs',
  asyncHandler((req, res) => {
    const d = logSchema.parse(req.body);
    const food = get('SELECT * FROM foods WHERE id = ?', [d.foodId]);
    if (!food) throw new BizError('食物不存在', 404);
    const id = insertDietLog(req.user.id, d.date || today(), d.mealType, food, d.amountG);
    return ok(res, get('SELECT * FROM diet_logs WHERE id = ?', [id]), '已记录');
  }),
);

/** 批量记录（AI 餐单采纳） */
const batchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  meals: z.array(
    z.object({
      mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
      items: z.array(z.object({ foodId: z.string().optional(), foodName: z.string().optional(), amountG: z.number().min(1).max(2000) })).min(1),
    }),
  ).min(1),
});

router.post(
  '/logs/batch',
  asyncHandler((req, res) => {
    const d = batchSchema.parse(req.body);
    const date = d.date || today();
    let count = 0;
    for (const meal of d.meals) {
      for (const it of meal.items) {
        const food = it.foodId ? get('SELECT * FROM foods WHERE id = ?', [it.foodId]) : get('SELECT * FROM foods WHERE name = ?', [it.foodName]);
        if (!food) continue;
        insertDietLog(req.user.id, date, meal.mealType, food, it.amountG);
        count += 1;
      }
    }
    return ok(res, { count, date }, `已添加 ${count} 条饮食记录`);
  }),
);

router.delete(
  '/logs/:id',
  asyncHandler((req, res) => {
    const row = get('SELECT * FROM diet_logs WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
    if (!row) throw new BizError('记录不存在', 404);
    run('DELETE FROM diet_logs WHERE id = ?', [row.id]);
    return ok(res, null, '已删除');
  }),
);

/** AI 生成一日饮食方案（限流，避免频繁调用大模型） */
router.post(
  '/recommend',
  rateLimit({ limit: 10, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const goal = ['lose', 'gain', 'keep', 'shape'].includes(req.body?.goal) ? req.body.goal : undefined;
    const result = await generateDiet({ userId: req.user.id, goal });
    // meta 用可选链兜底：即使未来某个分支忘了返回 meta，也不至于让整个接口 500
    return ok(res, result, result.meta?.fallback ? '已由本地配餐引擎生成（未启用大模型）' : 'AI 饮食方案已生成');
  }),
);

/** 内部工具：插入一条饮食记录（统一做份量换算，避免前端算错） */
function insertDietLog(userId, date, mealType, food, amountG) {
  const k = amountG / 100;
  return run(
    `INSERT INTO diet_logs (user_id, log_date, meal_type, food_id, food_name, amount_g, kcal, protein, fat, carb)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      userId,
      date,
      mealType,
      food.id,
      food.name,
      amountG,
      Math.round(food.kcal * k),
      Number((food.protein * k).toFixed(1)),
      Number((food.fat * k).toFixed(1)),
      Number((food.carb * k).toFixed(1)),
    ],
  ).lastInsertRowid;
}

export default router;
