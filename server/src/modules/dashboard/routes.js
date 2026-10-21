/**
 * 仪表盘路由（首页数据聚合）
 * ---------------------------------------------------------------------------
 * GET /api/dashboard/overview
 * 一次性返回首页所需的全部数据，减少瀑布式请求：
 *   今日概览（消耗/摄入/体重/打卡）+ 目标完成度 + 近 7 天趋势 + 今日计划 + AI 建议
 */
import { Router } from 'express';
import { asyncHandler, ok } from '../../utils/response.js';
import { all, get, today, shiftDate } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { buildProfile } from '../../ai/profile.js';
import { quickSuggestions } from '../../ai/coachAgent.js';
import { aiCapability } from '../../ai/provider.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/overview',
  asyncHandler((req, res) => {
    const uid = req.user.id;
    const t = today();
    const weekFrom = shiftDate(t, -6);

    // ---------- 今日运动
    const todayLogs = all('SELECT * FROM workout_logs WHERE user_id = ? AND log_date = ?', [uid, t]);
    const todayBurn = Math.round(todayLogs.reduce((s, r) => s + r.calories, 0));
    const todayMinutes = Math.round(todayLogs.reduce((s, r) => s + r.duration_min, 0));

    // ---------- 今日饮食
    const todayDiet = get('SELECT SUM(kcal) k, SUM(protein) p, SUM(carb) c, SUM(fat) f FROM diet_logs WHERE user_id = ? AND log_date = ?', [uid, t]);

    // ---------- 身体数据与目标
    const { profile, metrics } = buildProfile(uid, {});
    const latestBody = get('SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1', [uid]);
    const prevBody = get('SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1 OFFSET 1', [uid]);

    // ---------- 本周打卡
    const weekLogs = all('SELECT * FROM workout_logs WHERE user_id = ? AND log_date >= ?', [uid, weekFrom]);
    const weekDays = new Set(weekLogs.map((r) => r.log_date)).size;

    // ---------- 近 7 天收支趋势（双折线：消耗 vs 摄入）
    const trend = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = shiftDate(t, -i);
      const burn = all('SELECT calories FROM workout_logs WHERE user_id = ? AND log_date = ?', [uid, d]).reduce((s, r) => s + r.calories, 0);
      const intake = get('SELECT SUM(kcal) k FROM diet_logs WHERE user_id = ? AND log_date = ?', [uid, d]);
      trend.push({ date: d, burn: Math.round(burn), intake: Math.round(intake.k || 0) });
    }

    // ---------- 今日计划（取当前计划的今日动作）
    const plan = get(`SELECT * FROM plans WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [uid]);
    let planToday = null;
    if (plan) {
      const items = all('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY week_no, day_no, order_no', [plan.id]);
      const total = items.length;
      const done = items.filter((i) => i.done).length;
      planToday = {
        id: plan.id,
        title: plan.title,
        weekProgress: { total, done, rate: total ? Math.round((done / total) * 100) : 0 },
      };
    }

    // ---------- AI 建议（规则生成，零成本）
    const { tips } = quickSuggestions(uid);

    // ---------- 目标完成度
    const intakeKcal = Math.round(todayDiet.k || 0);
    const goals = [
      {
        key: 'kcalOut',
        label: '今日运动消耗',
        current: todayBurn,
        target: Math.round(metrics.tdee * 0.15), // 运动消耗目标：TDEE 的 15%
        unit: 'kcal',
      },
      { key: 'kcalIn', label: '今日饮食摄入', current: intakeKcal, target: metrics.targetCalories, unit: 'kcal' },
      { key: 'minutes', label: '今日运动时长', current: todayMinutes, target: 30, unit: '分钟' },
      { key: 'weekDays', label: '本周训练天数', current: weekDays, target: profile.daysPerWeek, unit: '天' },
    ].map((g) => ({ ...g, rate: Math.min(100, Math.round((g.current / (g.target || 1)) * 100)) }));

    return ok(res, {
      date: t,
      user: { nickname: req.user.nickname, avatar: req.user.avatar || '', goalText: profile.goalText },
      body: latestBody
        ? {
            weight: latestBody.weight_kg,
            bodyFat: latestBody.body_fat,
            bmi: metrics.bmi,
            bmiLevel: metrics.bmiLevel,
            weightChange: prevBody ? Number((latestBody.weight_kg - prevBody.weight_kg).toFixed(1)) : null,
            recordDate: latestBody.record_date,
          }
        : null,
      today: {
        burn: todayBurn,
        minutes: todayMinutes,
        checkinCount: todayLogs.length,
        intake: intakeKcal,
        protein: Math.round(todayDiet.p || 0),
        carb: Math.round(todayDiet.c || 0),
        fat: Math.round(todayDiet.f || 0),
        netCalories: intakeKcal - todayBurn,
      },
      goals,
      trend,
      plan: planToday,
      tips,
      ai: aiCapability(),
      streak: calcStreak(uid),
    });
  }),
);

/** 连续打卡天数 */
function calcStreak(uid) {
  const days = new Set(all('SELECT DISTINCT log_date FROM workout_logs WHERE user_id = ? ORDER BY log_date DESC LIMIT 400', [uid]).map((r) => r.log_date));
  let streak = 0;
  let cursor = today();
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

export default router;
