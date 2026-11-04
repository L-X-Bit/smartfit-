/**
 * AI 拍照识热量路由
 * ---------------------------------------------------------------------------
 * POST   /api/food-scan/analyze     上传食物照片 → 多模态识别 → 返回结构化营养数据
 * GET    /api/food-scan/history     识别历史
 * GET    /api/food-scan/:id         单条识别详情
 * POST   /api/food-scan/:id/log     把识别结果写入今日饮食记录（可选餐次、可改份量）
 * DELETE /api/food-scan/:id         删除识别记录
 * GET    /api/food-scan/capability  能力探测（前端据此决定是否显示入口）
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { today, get, run } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/common.js';
import { config } from '../../config/index.js';
import { analyzeFoodImage, listScans, getScan, removeScan, markScanLogged, degradedResult } from '../../ai/foodVision.js';
import { adviseMeal } from '../../ai/mealAdvisor.js';
import { buildProfile } from '../../ai/profile.js';

const router = Router();
router.use(requireAuth);

/** 能力探测：视觉模型是否可用 + 今日剩余热量额度（前端顶部提示用） */
router.get(
  '/capability',
  asyncHandler((req, res) => {
    const { metrics } = buildProfile(req.user.id, {});
    const todayIn = get('SELECT SUM(kcal) AS k FROM diet_logs WHERE user_id = ? AND log_date = ?', [req.user.id, today()]);
    return ok(res, {
      visionEnabled: config.ai.visionEnabled,
      model: config.ai.visionEnabled ? config.ai.visionModel : null,
      todayTarget: metrics.targetCalories,
      todayIntake: Math.round(todayIn?.k || 0),
      todayRemaining: Math.max(0, metrics.targetCalories - Math.round(todayIn?.k || 0)),
    });
  }),
);

/**
 * 识别一张照片
 * 说明：图片以 base64 dataURL 提交（前端已用 canvas 压缩），
 * 这样无需引入 multipart 中间件，且能一次性把原图落盘供历史回溯。
 *
 * 上限说明：这里只做「别把明显超大的东西塞进来」的粗筛，
 * 真正的体积判定在 foodVision.decodeImagePayload 里（超限返回 413 + 具体 MB 数）。
 * 之前 zod 上限写 12MB 而 express body 上限 10MB，手机原图的报错会变成一句看不懂的
 * 「服务器内部错误」——两个数字现在统一由 config.uploads 决定。
 */
const analyzeSchema = z.object({
  // 下限只拦"根本没传图"（一张 1×1 的合法 GIF base64 也就 70 多个字符，不能按长度当画质判断）
  imageDataUrl: z.string().min(40, '请上传食物照片').max(20_000_000, '图片过大，请压缩后再试'),
});

router.post(
  '/analyze',
  rateLimit({ limit: 12, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const { imageDataUrl } = analyzeSchema.parse(req.body);

    /**
     * 硬超时兜底（验收清单第 3 条：该接口任意输入 15s 内必须返回）
     * -------------------------------------------------------------------
     * visionChat 内部已有 15s 预算，但网络栈偶尔会出现「取消耗时比预期久」的情况。
     * 这里再加一层 Promise.race，超过 15.5s 直接返回降级结果，绝不让请求悬着。
     */
    const timeoutMs = config.ai.visionTimeoutMs + 500;
    const hardTimeout = new Promise((resolve) => {
      setTimeout(
        () =>
          resolve(
            degradedResult({
              reason: `AI 识别超过 ${Math.round(timeoutMs / 1000)} 秒未返回，请换一张更小的照片重试，或手动选择食物`,
              cause: 'route_timeout',
              latencyMs: timeoutMs,
            }),
          ),
        timeoutMs,
      ).unref?.();
    });

    /**
     * 最后一道防线：整条链路包 try/catch，任何未预期的异常都降级成「没识别到食物」，
     * 绝不让 camera 识热量这个旗舰功能给用户一个 500。
     * （报告里的建议就是「把 ai/vision-food 的兜底抄过来」——那边是 200 + 空结果 + 原因，
     *   这里一致；区别只在于我们把原因也一并返回，前端能显示得更具体。）
     *
     * 只有两类错误继续往上抛（由错误中间件给出准确状态码）：
     *   · BizError 4xx：图片过大 / 不是图片 / 没配置视觉模型 —— 这些用户能自己处理；
     *   · 其余一律降级，并打日志留痕（含 requestId，方便排查）。
     */
    let result;
    try {
      result = await Promise.race([analyzeFoodImage({ userId: req.user.id, imageDataUrl }), hardTimeout]);
    } catch (err) {
      if (err?.name === 'BizError' || err?.httpStatus) throw err;
      console.error(`[food-scan] 识别失败已降级 #${res.locals?.requestId}:`, err?.stack || err);
      result = degradedResult({
        reason: '识别服务刚才出了点问题，已自动降级。请重试一次，或直接在下方手动选择食物',
        cause: err?.message || 'unexpected_error',
        latencyMs: 0,
      });
    }

    // 降级结果（纯色小图 / 上游超时 / 上游拒图 / 未预期异常）：仍然 code=0，把原因交给前端展示，
    // 用户可以「换一张」或手动选食物继续，不会看到刺眼的 500（验收清单第 2、3 条）
    if (result.degraded) {
      return ok(res, result, `识别未完成：${result.reason}`);
    }
    if (result.notFood) {
      return ok(res, result, `没识别到食物：${result.reason}`);
    }
    const { meta } = result;
    return ok(
      res,
      result,
      `识别完成：${meta.totalItems} 种食物，${meta.matchedCount} 种已匹配食物库（${meta.libraryRatio}%），共 ${result.totals.kcal} kcal`,
    );
  }),
);

/** 识别历史 */
router.get(
  '/history',
  asyncHandler((req, res) => ok(res, listScans(req.user.id, Math.min(50, Number(req.query.limit) || 20)))),
);

/**
 * 份量试算 + 个性化饮食建议
 * ---------------------------------------------------------------------------
 * 前端把用户填好克数的食物列表发来，后端：
 *   ① 用规则引擎算出确定性结论（热量占目标比例、蛋白达成度、脂肪供能比、剩余额度、是否缺蔬菜）
 *   ② 把这些结论 + 用户身体条件交给大模型，生成有针对性的中文点评
 *   ③ 模型不可用则用规则结论拼模板（降级）
 * 注意：热量换算在前端已完成（前端持有每 100g 库值），此处只做评估，不再重算克数。
 */
const adviceSchema = z.object({
  mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
  imageDesc: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(30),
        amountG: z.number().min(1).max(2000),
        kcal: z.number().min(0).max(5000),
        protein: z.number().min(0).max(500).optional(),
        fat: z.number().min(0).max(500).optional(),
        carb: z.number().min(0).max(1000).optional(),
      }),
    )
    .min(1, '请至少添加一种食物')
    .max(20, '一次最多评估 20 种食物'),
});

router.post(
  '/advice',
  rateLimit({ limit: 15, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const d = adviceSchema.parse(req.body);
    const result = await adviseMeal({
      userId: req.user.id,
      items: d.items,
      mealType: d.mealType || 'lunch',
      imageDesc: d.imageDesc || '',
    });
    const verdictText = { good: '搭配合适', high: '热量偏高', low: '热量偏低' }[result.analysis.verdict];
    return ok(res, result, `评估完成：${verdictText}（占今日目标 ${result.analysis.shareOfTarget}%）`);
  }),
);

/** 单条详情 */
router.get(
  '/:id',
  asyncHandler((req, res) => {
    const scan = getScan(req.user.id, Number(req.params.id));
    if (!scan) throw new BizError('识别记录不存在', 404);
    return ok(res, scan);
  }),
);

/**
 * 把识别结果写入饮食记录
 * - 允许前端传入调整后的份量（用户可能改「米饭 200g → 150g」）
 * - 命中库的食物按库值精确换算；未命中的按模型估算值等比例缩放
 */
const logSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(30),
        amountG: z.number().min(1).max(2000),
        foodId: z.string().nullable().optional(),
        kcal: z.number().min(0).max(5000),
        protein: z.number().min(0).max(500).optional(),
        fat: z.number().min(0).max(500).optional(),
        carb: z.number().min(0).max(1000).optional(),
      }),
    )
    .min(1, '至少选择一种食物'),
});

router.post(
  '/:id/log',
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    const scan = getScan(req.user.id, id);
    if (!scan) throw new BizError('识别记录不存在', 404);
    if (scan.loggedMeal) throw new BizError(`这餐已经记入「${mealLabel(scan.loggedMeal)}」了，请勿重复记录`);

    const d = logSchema.parse(req.body);
    const date = d.date || today();
    let count = 0;

    for (const it of d.items) {
      // 命中食物库的，按库值重新换算（精确）；未命中的沿用前端传来的模型值
      if (it.foodId) {
        const food = get('SELECT * FROM foods WHERE id = ?', [it.foodId]);
        if (food) {
          const k = it.amountG / 100;
          run(
            `INSERT INTO diet_logs (user_id, log_date, meal_type, food_id, food_name, amount_g, kcal, protein, fat, carb)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              req.user.id,
              date,
              d.mealType,
              food.id,
              food.name,
              it.amountG,
              Math.round(food.kcal * k),
              Number((food.protein * k).toFixed(1)),
              Number((food.fat * k).toFixed(1)),
              Number((food.carb * k).toFixed(1)),
            ],
          );
          count += 1;
          continue;
        }
      }
      run(
        `INSERT INTO diet_logs (user_id, log_date, meal_type, food_id, food_name, amount_g, kcal, protein, fat, carb)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [req.user.id, date, d.mealType, null, it.name, it.amountG, Math.round(it.kcal), it.protein || 0, it.fat || 0, it.carb || 0],
      );
      count += 1;
    }

    markScanLogged(req.user.id, id, d.mealType);
    return ok(res, { count, mealType: d.mealType, date }, `已把 ${count} 种食物记入${mealLabel(d.mealType)}`);
  }),
);

/** 删除识别记录 */
router.delete(
  '/:id',
  asyncHandler((req, res) => {
    const removed = removeScan(req.user.id, Number(req.params.id));
    if (!removed) throw new BizError('识别记录不存在', 404);
    return ok(res, null, '已删除');
  }),
);

function mealLabel(type) {
  return { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }[type] || type;
}

export default router;
