/**
 * 运动打卡路由
 * ---------------------------------------------------------------------------
 * GET    /api/checkin/logs        打卡记录（可选 from/to 日期范围）
 * POST   /api/checkin/logs        新增打卡（后端统一用 MET 公式算热量，防止前端随意填）
 * DELETE /api/checkin/logs/:id    删除打卡
 * GET    /api/checkin/stats       统计：日历热力图 / 连续天数 / 本周汇总 / 分类占比
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { all, get, run, today, shiftDate } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { calcCalories } from '../../utils/health.js';

const router = Router();
router.use(requireAuth);

/** 打卡参数校验 */
const logSchema = z.object({
  logDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  exerciseId: z.string().max(40).optional().nullable(),
  exerciseName: z.string().min(1, '请填写运动名称').max(40),
  category: z.string().max(10).optional(),
  durationMin: z.number().min(1, '时长至少 1 分钟').max(600, '单次时长不要超过 10 小时'),
  intensity: z.enum(['low', 'medium', 'high']).optional(),
  sets: z.number().int().min(0).max(30).optional(),
  reps: z.number().int().min(0).max(300).optional(),
  distanceKm: z.number().min(0).max(200).optional().nullable(),
  feeling: z.string().max(10).optional(),
  note: z.string().max(200).optional(),
  photo: z.string().max(500).optional(),
});

router.get(
  '/logs',
  asyncHandler((req, res) => {
    const { from, to } = req.query;
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const where = ['user_id = ?'];
    const params = [req.user.id];
    if (from) {
      where.push('log_date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('log_date <= ?');
      params.push(to);
    }
    params.push(limit);
    const rows = all(`SELECT * FROM workout_logs WHERE ${where.join(' AND ')} ORDER BY log_date DESC, id DESC LIMIT ?`, params);
    return ok(res, rows.map(toDto));
  }),
);

router.post(
  '/logs',
  asyncHandler((req, res) => {
    const d = logSchema.parse(req.body);

    // 取动作库里的 MET（自定义运动则用默认值 6.0），再用最新体重估算热量
    const exercise = d.exerciseId ? get('SELECT * FROM exercises WHERE id = ?', [d.exerciseId]) : null;
    const met = exercise?.met ?? 6.0;
    const latestBody = get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1', [req.user.id]);
    const weight = latestBody?.weight_kg || 65;
    const calories = calcCalories(met, weight, d.durationMin, d.intensity || 'medium');

    const id = run(
      `INSERT INTO workout_logs (user_id, log_date, exercise_id, exercise_name, category, duration_min, intensity, sets, reps, distance_km, calories, feeling, note, photo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.id,
        d.logDate || today(),
        d.exerciseId || null,
        d.exerciseName,
        d.category || exercise?.category || '力量',
        d.durationMin,
        d.intensity || 'medium',
        d.sets || 0,
        d.reps || 0,
        d.distanceKm ?? null,
        calories,
        d.feeling || '',
        d.note || '',
        d.photo || '',
      ],
    ).lastInsertRowid;

    const row = get('SELECT * FROM workout_logs WHERE id = ?', [id]);
    return ok(res, { ...toDto(row), met, weightUsed: weight }, `打卡成功，消耗约 ${calories} kcal`);
  }),
);

router.delete(
  '/logs/:id',
  asyncHandler((req, res) => {
    const row = get('SELECT * FROM workout_logs WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
    if (!row) throw new BizError('打卡记录不存在', 404);
    run('DELETE FROM workout_logs WHERE id = ?', [row.id]);
    return ok(res, null, '已删除');
  }),
);

/**
 * 打卡统计：一次返回多种图表所需的数据，减少前端请求次数
 */
router.get(
  '/stats',
  asyncHandler((req, res) => {
    const t = today();
    const rows = all(
      'SELECT * FROM workout_logs WHERE user_id = ? AND log_date >= ? ORDER BY log_date ASC',
      [req.user.id, shiftDate(t, -119)],
    );

    // 1) 日历热力图：日期 → 总时长/次数/消耗
    const dayMap = new Map();
    for (const r of rows) {
      const item = dayMap.get(r.log_date) || { date: r.log_date, minutes: 0, calories: 0, count: 0 };
      item.minutes += r.duration_min;
      item.calories += r.calories;
      item.count += 1;
      dayMap.set(r.log_date, item);
    }

    // 2) 连续打卡天数（从今天往前推）
    let streak = 0;
    let cursor = t;
    while (dayMap.has(cursor)) {
      streak += 1;
      cursor = shiftDate(cursor, -1);
    }

    // 3) 本周（最近 7 天）汇总
    const weekFrom = shiftDate(t, -6);
    const weekRows = rows.filter((r) => r.log_date >= weekFrom);
    const week = {
      count: weekRows.length,
      minutes: Math.round(weekRows.reduce((s, r) => s + r.duration_min, 0)),
      calories: Math.round(weekRows.reduce((s, r) => s + r.calories, 0)),
      days: new Set(weekRows.map((r) => r.log_date)).size,
      target: get('SELECT weekly_target FROM users WHERE id = ?', [req.user.id])?.weekly_target || 3,
    };

    // 4) 分类占比（饼图）
    const catMap = new Map();
    for (const r of rows) {
      catMap.set(r.category, (catMap.get(r.category) || 0) + r.duration_min);
    }

    // 5) 最近 7 天每日消耗（柱状图）
    const last7 = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = shiftDate(t, -i);
      const item = dayMap.get(d);
      last7.push({ date: d, minutes: item?.minutes || 0, calories: Math.round(item?.calories || 0) });
    }

    // 6) 高频运动 Top5
    const nameMap = new Map();
    for (const r of rows) nameMap.set(r.exercise_name, (nameMap.get(r.exercise_name) || 0) + 1);
    const topExercises = [...nameMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

    return ok(res, {
      heatmap: [...dayMap.values()].map((d) => ({ ...d, minutes: Math.round(d.minutes), calories: Math.round(d.calories) })),
      streak,
      week,
      categoryShare: [...catMap.entries()].map(([name, value]) => ({ name, value: Math.round(value) })),
      last7,
      topExercises,
      totalDays: new Set(rows.map((r) => r.log_date)).size,
      totalMinutes: Math.round(rows.reduce((s, r) => s + r.duration_min, 0)),
      totalCalories: Math.round(rows.reduce((s, r) => s + r.calories, 0)),
    });
  }),
);

function toDto(r) {
  return {
    id: r.id,
    logDate: r.log_date,
    exerciseId: r.exercise_id,
    exerciseName: r.exercise_name,
    category: r.category,
    durationMin: r.duration_min,
    intensity: r.intensity,
    sets: r.sets,
    reps: r.reps,
    distanceKm: r.distance_km,
    calories: Math.round(r.calories),
    feeling: r.feeling,
    note: r.note,
    photo: r.photo,
    createdAt: r.created_at,
  };
}

export default router;
