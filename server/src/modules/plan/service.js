/**
 * 训练计划数据服务
 * ---------------------------------------------------------------------------
 * 职责：把「结构化计划对象」落库 / 读取 / 打勾 / 统计进度。
 * AI 层（planAgent）只负责产出一个符合契约的对象，持久化细节全在这里，
 * 这样换存储（SQLite → MySQL）不需要改动 AI 代码。
 */
import { get, all, run, tx } from '../../db/index.js';
import { BizError } from '../../utils/response.js';

/**
 * 保存计划（会先把该用户之前处于 active 的计划归档，保证「当前计划」唯一）
 * @param {object} p
 * @param {number} p.userId
 * @param {object} p.plan 计划对象（与 AI 输出同构）
 * @param {'ai'|'fallback'|'cache'|'manual'} p.source
 * @param {object} p.aiMeta AI 元信息（耗时/供应商/RAG/审核等）
 * @param {string} p.startDate 开始日期
 */
export function savePlan({ userId, plan, source = 'ai', aiMeta = {}, startDate }) {
  const planId = tx(() => {
    // 归档旧计划
    run(`UPDATE plans SET status = 'archived' WHERE user_id = ? AND status = 'active'`, [userId]);

    const newId = run(
      `INSERT INTO plans (user_id, title, goal, level, weeks, days_per_week, summary, nutrition_tips, ai_meta, source, status, start_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId,
        plan.title,
        plan.goal || 'keep',
        plan.level || 'beginner',
        plan.weeks || 4,
        plan.daysPerWeek || 3,
        plan.summary || '',
        plan.nutritionTips || '',
        JSON.stringify(aiMeta || {}),
        source,
        'active',
        startDate || null,
      ],
    ).lastInsertRowid;

    for (const day of plan.weeklySchedule || []) {
      day.items.forEach((item, idx) => {
        run(
          `INSERT INTO plan_items (plan_id, week_no, day_no, order_no, exercise_id, exercise_name, target_group, sets, reps, rest_sec, duration_min, note, done)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          [
            newId,
            day.week,
            day.day,
            idx + 1,
            item.exerciseId,
            item.exerciseName,
            item.targetGroup || '',
            item.sets || 0,
            item.reps || '',
            item.restSec || 60,
            item.durationMin || 0,
            item.note || '',
          ],
        );
      });
    }
    return newId;
  });

  return getPlanDetail(planId, userId);
}

/**
 * 读取计划详情，并把扁平的 plan_items 分组成「周 → 天 → 动作」结构，便于前端渲染
 */
export function getPlanDetail(planId, userId) {
  const plan = get('SELECT * FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  if (!plan) throw new BizError('计划不存在', 404);

  const items = all('SELECT * FROM plan_items WHERE plan_id = ? ORDER BY week_no, day_no, order_no', [planId]);
  const weekMap = new Map();
  for (const it of items) {
    if (!weekMap.has(it.week_no)) weekMap.set(it.week_no, new Map());
    const dayMap = weekMap.get(it.week_no);
    if (!dayMap.has(it.day_no)) dayMap.set(it.day_no, []);
    dayMap.get(it.day_no).push(it);
  }
  const weeklySchedule = [...weekMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, dayMap]) => ({
      week,
      days: [...dayMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, list]) => ({
          day,
          focus: guessFocus(list),
          items: list,
          doneCount: list.filter((i) => i.done).length,
          totalCount: list.length,
        })),
    }));

  return {
    id: plan.id,
    title: plan.title,
    goal: plan.goal,
    level: plan.level,
    weeks: plan.weeks,
    daysPerWeek: plan.days_per_week,
    summary: plan.summary,
    nutritionTips: plan.nutrition_tips,
    source: plan.source,
    status: plan.status,
    startDate: plan.start_date,
    createdAt: plan.created_at,
    aiMeta: safeParse(plan.ai_meta),
    weeklySchedule,
    progress: summarizeProgress(items),
  };
}

/** 由动作推断当天训练主题（数据库只存动作，不存主题，读取时推断，减少冗余） */
function guessFocus(items) {
  const groups = {};
  for (const it of items) {
    const g = it.target_group || '综合';
    groups[g] = (groups[g] || 0) + 1;
  }
  const top = Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([g]) => g);
  return top.length ? `${top.join(' + ')}训练` : '综合训练';
}

/** 进度统计 */
function summarizeProgress(items) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  return { total, done, rate: total ? Number(((done / total) * 100).toFixed(1)) : 0 };
}

/** 列出用户全部计划（历史记录） */
export function listPlans(userId) {
  return all(
    `SELECT p.*, (SELECT COUNT(*) FROM plan_items i WHERE i.plan_id = p.id) AS item_count,
            (SELECT COUNT(*) FROM plan_items i WHERE i.plan_id = p.id AND i.done = 1) AS done_count
     FROM plans p WHERE p.user_id = ? ORDER BY p.id DESC`,
    [userId],
  ).map((p) => ({
    id: p.id,
    title: p.title,
    goal: p.goal,
    weeks: p.weeks,
    daysPerWeek: p.days_per_week,
    source: p.source,
    status: p.status,
    createdAt: p.created_at,
    itemCount: p.item_count,
    doneCount: p.done_count,
    aiMeta: safeParse(p.ai_meta),
  }));
}

/**
 * 勾选 / 取消勾选某个动作（打卡联动：勾选后可选择同步生成一条运动打卡）
 * @returns 更新后的计划进度
 */
export function togglePlanItem(userId, itemId, done) {
  const item = get(
    `SELECT i.*, p.user_id FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE i.id = ?`,
    [itemId],
  );
  if (!item) throw new BizError('计划动作不存在', 404);
  if (item.user_id !== userId) throw new BizError('无权操作该计划', 403);

  run('UPDATE plan_items SET done = ?, done_at = ? WHERE id = ?', [
    done ? 1 : 0,
    done ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
    itemId,
  ]);

  const items = all('SELECT * FROM plan_items WHERE plan_id = ?', [item.plan_id]);
  return { itemId, done: Boolean(done), progress: summarizeProgress(items) };
}

/** 删除计划 */
export function removePlan(userId, planId) {
  const plan = get('SELECT * FROM plans WHERE id = ? AND user_id = ?', [planId, userId]);
  if (!plan) throw new BizError('计划不存在', 404);
  run('DELETE FROM plans WHERE id = ?', [planId]);
}

function safeParse(str) {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return {};
  }
}
