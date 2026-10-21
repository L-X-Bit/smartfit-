/**
 * 训练计划路由
 * ---------------------------------------------------------------------------
 * POST   /api/plan/generate         AI 生成训练计划（多阶段 Agent 流水线）
 * GET    /api/plan/list             我的计划列表
 * GET    /api/plan/:id              计划详情（按周/天分组）
 * PATCH  /api/plan/items/:id        勾选完成 / 取消（可顺带生成运动打卡）
 * DELETE /api/plan/:id              删除计划
 * GET    /api/plan/latest/practice  今日待练（仪表盘用）
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { get, all, run, today } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/common.js';
import { generatePlan } from '../../ai/planAgent.js';
import { getPlanDetail, listPlans, togglePlanItem, removePlan } from './service.js';
import { calcCalories } from '../../utils/health.js';

const router = Router();
router.use(requireAuth);

/** 生成计划参数校验（宽松：多数字段可省略，省略则用用户档案默认值） */
const genSchema = z.object({
  goal: z.enum(['lose', 'gain', 'keep', 'shape']).optional(),
  daysPerWeek: z.number().int().min(1).max(7).optional(),
  weeks: z.number().int().min(1).max(12).optional(),
  sessionMinutes: z.number().int().min(15).max(120).optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  equipment: z.array(z.string().max(10)).max(10).optional(),
  conditions: z.array(z.string().max(20)).max(8).optional(),
  queryText: z.string().max(300).optional(),
});

router.post(
  '/generate',
  rateLimit({ limit: 8, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const params = genSchema.parse(req.body || {});
    const start = Date.now();
    const result = await generatePlan({ userId: req.user.id, req: params });

    // 把生成过程（各阶段耗时、RAG 命中、审核报告）一并返回，前端「AI 生成过程」面板可实时展示
    return ok(
      res,
      {
        ...result,
        elapsedMs: Date.now() - start,
      },
      result.meta.fallback ? '已由本地规则引擎生成计划（未启用大模型）' : 'AI 计划生成完成',
    );
  }),
);

router.get(
  '/list',
  asyncHandler((req, res) => ok(res, listPlans(req.user.id))),
);

/** 今日待练：返回当前计划中「本周第 N 天」的动作，供仪表盘直接打勾 */
router.get(
  '/latest/practice',
  asyncHandler((req, res) => {
    const plan = get(`SELECT * FROM plans WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [req.user.id]);
    if (!plan) return ok(res, null);

    const startDate = plan.start_date || plan.created_at.slice(0, 10);
    const daysPassed = Math.floor((new Date(today()) - new Date(startDate)) / 86400000);
    const week = Math.min(plan.weeks, Math.floor(daysPassed / 7) + 1);
    // 计划里的 day 是 1~7，映射到本周；若当天没有训练日，取本周下一个有动作的日子
    const items = all('SELECT * FROM plan_items WHERE plan_id = ? AND week_no = ? ORDER BY day_no, order_no', [plan.id, week]);
    const days = [...new Set(items.map((i) => i.day_no))];
    const weekday = new Date().getDay() === 0 ? 7 : new Date().getDay();
    const targetDay = days.includes(weekday) ? weekday : days.find((d) => d >= weekday) || days[0];

    return ok(res, {
      planId: plan.id,
      title: plan.title,
      week,
      day: targetDay,
      isRestDay: !days.includes(weekday),
      items: items.filter((i) => i.day_no === targetDay).map((i) => ({
        id: i.id,
        exerciseId: i.exercise_id,
        exerciseName: i.exercise_name,
        targetGroup: i.target_group,
        sets: i.sets,
        reps: i.reps,
        restSec: i.rest_sec,
        durationMin: i.duration_min,
        note: i.note,
        done: Boolean(i.done),
      })),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler((req, res) => ok(res, getPlanDetail(Number(req.params.id), req.user.id))),
);

/** 勾选计划动作；autoCheckin=true 时同步生成一条运动打卡（计划 → 打卡闭环） */
router.patch(
  '/items/:id',
  asyncHandler((req, res) => {
    const done = Boolean(req.body?.done);
    const result = togglePlanItem(req.user.id, Number(req.params.id), done);

    let checkin = null;
    if (done && req.body?.autoCheckin) {
      const item = get('SELECT * FROM plan_items WHERE id = ?', [Number(req.params.id)]);
      const exercise = item.exercise_id ? get('SELECT * FROM exercises WHERE id = ?', [item.exercise_id]) : null;
      const body = get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1', [req.user.id]);
      const met = exercise?.met ?? 5;
      // 力量动作按「组数 × 次数 × 3 秒」估算时长，最少 10 分钟
      const minutes = item.duration_min || Math.max(10, Math.round(((item.sets || 3) * 3 * 30) / 60));
      const calories = calcCalories(met, body?.weight_kg || 65, minutes, 'medium');
      const id = run(
        `INSERT INTO workout_logs (user_id, log_date, exercise_id, exercise_name, category, duration_min, intensity, sets, reps, calories, feeling, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.user.id, today(), item.exercise_id, item.exercise_name, exercise?.category || '力量', minutes, 'medium', item.sets, Number(item.reps) || 0, calories, '适中', '由训练计划自动生成'],
      ).lastInsertRowid;
      checkin = get('SELECT * FROM workout_logs WHERE id = ?', [id]);
    }

    return ok(res, { ...result, checkin }, done ? '完成打卡' : '已取消完成');
  }),
);

router.delete(
  '/:id',
  asyncHandler((req, res) => {
    removePlan(req.user.id, Number(req.params.id));
    return ok(res, null, '计划已删除');
  }),
);

export default router;
