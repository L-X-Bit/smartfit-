/**
 * 演示数据「保鲜」
 * ===========================================================================
 * 线上验收报告里的两条与时间有关的问题：
 *   ① 首页「今日」栏的日期与本地日期不一致（时区问题，已在 db/index.js 用 APP_TZ 修掉）；
 *   ② 演示数据在部署那一刻写死：过几天再看，排行榜只剩 1 人、今日栏没数据、
 *      身体趋势图右端停在几天前——「演示数据随时间变空」。
 *
 * 这里做的是：**启动时**检查演示账号最近一条业务数据的日期，
 * 如果它比「今天」早 N 天，就把整批演示数据的日期整体平移 N 天（含 payload 里的 JSON、
 * 以及 created_at 时间戳），让演示永远停在「今天还有数据」的状态。
 *
 * 三条安全边界（很重要，否则会把真实用户数据搞乱）：
 *   1. 只处理**种子演示账号**（demo / lily / coach / runner），真实注册用户一行不动；
 *   2. 只有「最新数据比今天旧」时才平移；用户今天刚打过卡 → delta=0 → 什么都不做；
 *   3. 平移量超过 365 天视为数据异常（比如误连了别的库），直接跳过并告警。
 */
import { config } from '../config/index.js';
import { all, get, db, today, shiftDate, daysBetween, tx } from './index.js';

/** 种子演示账号（与 seed.js 保持一致） */
const SEED_USERNAMES = ['demo', 'lily', 'coach', 'runner'];

export function ensureDemoFresh() {
  if (!config.demoAutoShift) return { shifted: 0, reason: 'disabled（DEMO_AUTO_SHIFT=off）' };

  const seeds = all(`SELECT id, username FROM users WHERE username IN (${SEED_USERNAMES.map(() => '?').join(',')})`, SEED_USERNAMES);
  if (!seeds.length) return { shifted: 0, reason: '库里没有演示账号，跳过' };
  const ids = seeds.map((u) => u.id);
  const ph = ids.map(() => '?').join(',');
  const t = today();

  // 最近一条业务数据日期：身体记录 / 运动打卡 / 饮食记录 / 计划开始日 里最大的那个
  const row = get(
    `SELECT MAX(d) AS latest FROM (
       SELECT MAX(record_date) AS d FROM body_records WHERE user_id IN (${ph})
       UNION ALL SELECT MAX(log_date) FROM workout_logs WHERE user_id IN (${ph})
       UNION ALL SELECT MAX(log_date) FROM diet_logs WHERE user_id IN (${ph})
       UNION ALL SELECT MAX(start_date) FROM plans WHERE user_id IN (${ph})
     )`,
    [...ids, ...ids, ...ids, ...ids],
  );
  const latest = row?.latest || null;
  if (!latest) return { shifted: 0, reason: '演示数据为空，跳过' };

  const delta = daysBetween(latest, t);
  if (delta <= 0) return { shifted: 0, reason: `已是最新（最近数据 ${latest}）` };
  if (delta > 365) return { shifted: 0, reason: `最近数据 ${latest} 距今 ${delta} 天，疑似异常数据，跳过` };

  const mod = `+${delta} days`;
  const createdShift = [`datetime(created_at, '${mod}')`];

  tx(() => {
    // ---- 带业务日期的表：日期列整体平移 ----
    db.prepare(`UPDATE body_records SET record_date = date(record_date, '${mod}') WHERE user_id IN (${ph})`).run(...ids);
    db.prepare(`UPDATE workout_logs SET log_date = date(log_date, '${mod}') WHERE user_id IN (${ph})`).run(...ids);
    db.prepare(`UPDATE diet_logs SET log_date = date(log_date, '${mod}') WHERE user_id IN (${ph})`).run(...ids);
    db.prepare(`UPDATE plans SET start_date = date(start_date, '${mod}') WHERE user_id IN (${ph})`).run(...ids);

    // ---- 时间戳列：让「3 天前发的帖子」这类相对时间也保持一致 ----
    for (const table of ['body_records', 'workout_logs', 'diet_logs', 'plans', 'posts', 'comments', 'food_scans', 'ai_messages', 'ai_call_logs', 'device_syncs']) {
      try {
        db.prepare(`UPDATE ${table} SET created_at = ${createdShift[0]} WHERE user_id IN (${ph}) AND created_at IS NOT NULL`).run(...ids);
      } catch {
        /* 个别表没有 created_at 列，忽略 */
      }
    }

    // ---- device_syncs.payload 里是 JSON（rows[].date），必须逐条平移 ----
    const syncs = all(`SELECT id, payload FROM device_syncs WHERE user_id IN (${ph})`, ids);
    const upd = db.prepare('UPDATE device_syncs SET payload = ? WHERE id = ?');
    for (const s of syncs) {
      let obj;
      try {
        obj = JSON.parse(s.payload || '{}');
      } catch {
        continue;
      }
      if (Array.isArray(obj.rows)) {
        obj.rows = obj.rows.map((r) => ({ ...r, date: r?.date ? shiftDate(r.date, delta) : r?.date }));
      }
      upd.run(JSON.stringify(obj), s.id);
    }
  });

  console.log(`[演示数据] 已整体平移 ${delta} 天：${latest} → ${t}（账号 ${seeds.map((s) => s.username).join('/')}）`);
  return { shifted: delta, from: latest, to: t };
}
