/**
 * 可穿戴设备数据同步路由
 * ===========================================================================
 * 让「手表 / 手环」的数据进入平台，三条通路覆盖所有实际情况：
 *
 *  ① 蓝牙实时心率（POST /heart-rate）
 *     浏览器 Web Bluetooth 直连设备的**标准 GATT 心率服务（0x180D）**，
 *     手环、心率带、智能手表普遍支持，无需各家云 API 授权。
 *
 *  ② 文件导入（POST /import）
 *     手环 App 一般都能导出数据，这里解析 CSV / JSON 后批量写入。
 *     这是兼容性最好的一条路——任何品牌、任何型号都能用。
 *
 *  ③ 演示模式（POST /demo）
 *     没有设备时一键生成 7 天模拟数据，保证演示/答辩时功能完整可见。
 *
 * 说明（技术文档可讲）：华为/小米/Apple 的官方云 API 都需要企业资质与 OAuth 审核，
 * 校园项目无法在比赛周期内接入；因此采用「标准蓝牙协议 + 文件导入 + 演示兜底」的组合，
 * 既真实可用，又不依赖任何第三方授权。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { all, get, run, today, shiftDate } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/common.js';
import { calcCalories } from '../../utils/health.js';

const router = Router();
router.use(requireAuth);

/** 写库类接口统一限流：设备会按秒上传，但正常使用不会超过这个频次 */
const writeLimit = rateLimit({ limit: 30, windowMs: 60_000 });

/** 能力探测 + 概览 */
router.get(
  '/status',
  asyncHandler((req, res) => {
    const last = get('SELECT * FROM device_syncs WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
    const count = get('SELECT COUNT(*) AS c FROM device_syncs WHERE user_id = ?', [req.user.id]).c;
    // 今日身体数据（含设备写入的静息心率/睡眠），用于界面展示「设备数据已进入平台」
    const body = get('SELECT resting_hr, sleep_hours, record_date FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 1', [
      req.user.id,
    ]);
    return ok(res, {
      // Web Bluetooth 只在安全上下文（https / localhost）且 Chromium 内核可用
      bluetoothSupported: true, // 具体支持性由前端检测（后端恒返回 true，仅作提示）
      syncCount: count,
      lastSync: last ? { source: last.source, deviceName: last.device_name, summary: last.summary, createdAt: last.created_at } : null,
      latestBody: body ? { date: body.record_date, restingHr: body.resting_hr, sleepHours: body.sleep_hours } : null,
      importTemplate: buildCsvTemplate(),
      supportedDevices: ['蓝牙心率带（Polar H10 / 迈欧等）', '智能手环（小米 / 华为 / 荣耀）', '智能手表（Apple Watch / Garmin / 佳明）'],
    });
  }),
);

/**
 * 设备每日数据（供页面画「设备带来的一周数据」）
 * 把 import / demo 两类同步里 payload.rows 按日期合并，蓝牙会话不进这里（它是单次心率记录）。
 */
router.get(
  '/daily',
  asyncHandler((req, res) => {
    const days = Math.min(60, Math.max(7, Number(req.query.days) || 7));
    const from = shiftDate(today(), -(days - 1));
    const syncs = all(
      "SELECT payload FROM device_syncs WHERE user_id = ? AND source IN ('import','demo') ORDER BY id DESC LIMIT 20",
      [req.user.id],
    );
    /** @type {Record<string, {date:string, steps:number|null, restingHr:number|null, sleepHours:number|null}>} */
    const byDate = {};
    for (const s of syncs) {
      let rows = [];
      try {
        rows = JSON.parse(s.payload || '{}').rows || [];
      } catch {
        rows = [];
      }
      for (const r of rows) {
        if (!r?.date || r.date < from) continue;
        const cur = byDate[r.date] || { date: r.date, steps: null, restingHr: null, sleepHours: null };
        if (r.steps != null) cur.steps = r.steps;
        if (r.restingHr != null) cur.restingHr = r.restingHr;
        if (r.sleepHours != null) cur.sleepHours = r.sleepHours;
        byDate[r.date] = cur;
      }
    }
    const list = Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
    const sum = (k) => list.reduce((s, x) => s + (x[k] || 0), 0);
    return ok(res, {
      days,
      list,
      summary: {
        avgSteps: list.length ? Math.round(sum('steps') / list.length) : 0,
        avgRestingHr: list.length ? Math.round(sum('restingHr') / list.length) : 0,
        avgSleep: list.length ? Number((sum('sleepHours') / list.length).toFixed(1)) : 0,
        totalSteps: sum('steps'),
      },
    });
  }),
);

/** 同步历史 */
router.get(
  '/history',
  asyncHandler((req, res) => {
    const rows = all('SELECT * FROM device_syncs WHERE user_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
    return ok(
      res,
      rows.map((r) => ({
        id: r.id,
        source: r.source,
        deviceName: r.device_name,
        syncType: r.sync_type,
        summary: r.summary,
        recordCount: r.record_count,
        createdAt: r.created_at,
      })),
    );
  }),
);

/**
 * ① 保存一次心率会话
 * ---------------------------------------------------------------------------
 * 两种来源共用这一个接口：
 *   · 蓝牙心率带（Web Bluetooth 实时采集，samples 有几百个点）；
 *   · **手动录入**（手机浏览器没有蓝牙接口时的兜底：填平均/最高/最低/时长即可，
 *     samples 省略）。手动录入对「夸克 / 小米 / iOS Safari / 微信内置浏览器」同样可用，
 *     因为这些浏览器虽然没有 BLE 接口，但发 POST 请求毫无问题。
 */
const heartRateSchema = z.object({
  deviceName: z.string().max(60).optional(),
  avg: z.number().min(20).max(250),
  max: z.number().min(20).max(250),
  min: z.number().min(20).max(250),
  durationSec: z.number().min(1).max(36000),
  samples: z.array(z.number().min(20).max(250)).max(5000).optional(),
  /** 是否把平均心率记为该日静息心率（写入身体数据），默认记到今天 */
  saveAsRestingHr: z.boolean().optional(),
  /** 归属日期，缺省为今天；格式 YYYY-MM-DD（手动补录昨天/前天的数据用） */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').optional(),
});

router.post(
  '/heart-rate',
  writeLimit,
  asyncHandler((req, res) => {
    const d = heartRateSchema.parse(req.body);
    const payload = { avg: d.avg, max: d.max, min: d.min, durationSec: d.durationSec, samples: d.samples?.slice(-200) || [] };
    const summary = `心率会话 ${Math.round(d.durationSec)} 秒 · 平均 ${Math.round(d.avg)} / 最高 ${Math.round(d.max)} bpm`;

    let count = 0;
    if (d.saveAsRestingHr) {
      const t = d.date || today();
      const exist = get('SELECT id FROM body_records WHERE user_id = ? AND record_date = ? ORDER BY id DESC LIMIT 1', [req.user.id, t]);
      const hr = Math.round(d.avg);
      if (exist) {
        run('UPDATE body_records SET resting_hr = ? WHERE id = ?', [hr, exist.id]);
      } else {
        const latest = get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 1', [req.user.id]);
        run(
          'INSERT INTO body_records (user_id, record_date, weight_kg, resting_hr, note) VALUES (?,?,?,?,?)',
          [req.user.id, t, latest?.weight_kg || 65, hr, '由设备同步写入'],
        );
      }
      count = 1;
    }

    const id = run(
      `INSERT INTO device_syncs (user_id, source, device_name, sync_type, payload, summary, record_count)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, 'bluetooth', d.deviceName || '蓝牙心率设备', 'heart_rate', JSON.stringify(payload), summary, count],
    ).lastInsertRowid;

    return ok(res, { id, summary, recordCount: count }, count ? '心率已同步，并更新了今日静息心率' : '心率会话已保存');
  }),
);

/**
 * ② 文件导入（CSV / JSON 文本）
 * CSV 表头（大小写不敏感、列顺序无关）：
 *   date,steps,restingHr,sleepHours,weightKg,activeMinutes,hrAvg,hrMax,hrMin
 * 只填有值的列即可，缺列自动跳过。
 * 其中 hrAvg / hrMax / hrMin 是「当天心率统计」，来自手环 App 或 Apple 健康导出
 * （tools/apple-health-to-csv.mjs 生成的就是这套列），会随同步记录一起存档。
 */
const importSchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  content: z.string().min(5, '文件内容为空').max(500_000, '文件过大（请小于 500KB）'),
  deviceName: z.string().max(60).optional(),
  /** true 时只解析预览，不写库 */
  dryRun: z.boolean().optional(),
});

router.post(
  '/import',
  writeLimit,
  asyncHandler((req, res) => {
    const d = importSchema.parse(req.body);
    const rows = d.format === 'csv' ? parseCsv(d.content) : parseJson(d.content);
    if (!rows.length) throw new BizError('没有解析到有效数据行，请检查文件格式');

    // 归一化 + 校验
    const clean = [];
    for (const r of rows.slice(0, 400)) {
      const date = normalizeDate(r.date);
      if (!date) continue;
      const item = {
        date,
        steps: toNum(r.steps),
        restingHr: toNum(r.restingHr ?? r.resting_hr ?? r.hr),
        sleepHours: toNum(r.sleepHours ?? r.sleep_hours ?? r.sleep),
        weightKg: toNum(r.weightKg ?? r.weight_kg ?? r.weight),
        activeMinutes: toNum(r.activeMinutes ?? r.active_minutes ?? r.minutes),
        // 当天心率统计（Apple 健康 / 手环 App 导出时会有）
        hrAvg: toNum(r.hrAvg ?? r.hr_avg ?? r.avgHr ?? r.平均心率),
        hrMax: toNum(r.hrMax ?? r.hr_max ?? r.maxHr ?? r.最高心率),
        hrMin: toNum(r.hrMin ?? r.hr_min ?? r.minHr ?? r.最低心率),
      };
      if (
        item.steps === null &&
        item.restingHr === null &&
        item.sleepHours === null &&
        item.weightKg === null &&
        item.hrAvg === null
      ) {
        continue;
      }
      clean.push(item);
    }
    if (!clean.length) throw new BizError('数据行里没有可用的数值（steps / restingHr / sleepHours / weightKg）');

    if (d.dryRun) {
      return ok(res, { preview: clean.slice(0, 20), total: clean.length, written: 0 }, `解析到 ${clean.length} 行，确认后即可导入`);
    }

    // 写库：体重→身体数据；步数→按 MET 折算成一次"步行"打卡；睡眠/心率→附到身体数据
    let written = 0;
    let updated = 0;
    for (const it of clean) {
      const exist = get('SELECT id FROM body_records WHERE user_id = ? AND record_date = ? ORDER BY id DESC LIMIT 1', [req.user.id, it.date]);

      if (it.weightKg || it.restingHr || it.sleepHours) {
        const base = exist
          ? get('SELECT * FROM body_records WHERE id = ?', [exist.id])
          : get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 1', [req.user.id]);
        const weight = it.weightKg ?? base?.weight_kg ?? 65;
        if (exist) {
          run(
            `UPDATE body_records SET weight_kg = ?, resting_hr = COALESCE(?, resting_hr), sleep_hours = COALESCE(?, sleep_hours), note = COALESCE(NULLIF(note,''), '由设备导入') WHERE id = ?`,
            [weight, it.restingHr, it.sleepHours, exist.id],
          );
        } else {
          run(
            'INSERT INTO body_records (user_id, record_date, weight_kg, resting_hr, sleep_hours, note) VALUES (?,?,?,?,?,?)',
            [req.user.id, it.date, weight, it.restingHr, it.sleepHours, '由设备导入'],
          );
        }
        written += 1;
      }

      // 步数折算为一次步行打卡（时长按 100 步/分钟估算，热量走统一 MET 公式）
      if (it.steps && it.steps > 0) {
        const body = get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 1', [req.user.id]);
        if (upsertStepLog(req.user.id, it.date, it.steps, body?.weight_kg, '设备导入的步数')) written += 1;
        else updated += 1;
      }
    }

    const summary = `导入 ${clean.length} 行 · 写入 ${written} 条记录${updated ? `、更新 ${updated} 条打卡` : ''}（${clean[0].date} ~ ${clean[clean.length - 1].date}）`;
    const id = run(
      `INSERT INTO device_syncs (user_id, source, device_name, sync_type, payload, summary, record_count)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, 'import', d.deviceName || '导入文件', 'daily', JSON.stringify({ rows: clean.slice(0, 200) }), summary, written],
    ).lastInsertRowid;

    return ok(res, { id, summary, written, updated, total: clean.length }, summary);
  }),
);

/**
 * ③ 演示模式：生成最近 7 天的模拟设备数据
 * 用途：没有手环/答辩现场没有设备时，也能完整展示「设备 → 平台」的数据流。
 */
router.post(
  '/demo',
  writeLimit,
  asyncHandler((req, res) => {
    const days = Math.min(30, Math.max(1, Number(req.body?.days) || 7));
    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    let written = 0;
    let updated = 0;
    const rows = [];

    for (let i = days - 1; i >= 0; i -= 1) {
      const date = shiftDate(today(), -i);
      // 工作日步数多、周末少；心率与睡眠做小幅波动
      const dow = new Date(`${date}T00:00:00`).getDay();
      const base = dow === 0 || dow === 6 ? 4200 : 8600;
      const steps = Math.round(base + (Math.random() - 0.5) * 2600);
      const restingHr = Math.round(64 + (Math.random() - 0.5) * 6);
      const sleepHours = Number((7.1 + (Math.random() - 0.5) * 1.2).toFixed(1));

      rows.push({ date, steps, restingHr, sleepHours });

      const exist = get('SELECT id FROM body_records WHERE user_id = ? AND record_date = ? ORDER BY id DESC LIMIT 1', [req.user.id, date]);
      const latestW = get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 1', [req.user.id]);
      if (exist) {
        run('UPDATE body_records SET resting_hr = ?, sleep_hours = ?, note = COALESCE(NULLIF(note,\'\'), \'演示设备数据\') WHERE id = ?', [restingHr, sleepHours, exist.id]);
      } else {
        run(
          'INSERT INTO body_records (user_id, record_date, weight_kg, resting_hr, sleep_hours, note) VALUES (?,?,?,?,?,?)',
          [req.user.id, date, latestW?.weight_kg || 70, restingHr, sleepHours, '演示设备数据'],
        );
      }
      written += 1;

      // 步数→步行打卡：与导入共用同一个 upsert，避免「同一天两条步行打卡」重复算热量
      if (upsertStepLog(req.user.id, date, steps, latestW?.weight_kg, '演示设备步数')) written += 1;
      else updated += 1;
    }

    const summary = `演示设备同步 ${days} 天数据 · 写入 ${written} 条${updated ? `、更新 ${updated} 条打卡` : ''}`;
    const id = run(
      `INSERT INTO device_syncs (user_id, source, device_name, sync_type, payload, summary, record_count)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.id, 'demo', '演示手环（模拟）', 'daily', JSON.stringify({ rows }), summary, written],
    ).lastInsertRowid;

    return ok(res, { id, summary, written, updated, rows }, summary);
  }),
);

// ---------------------------------------------------------------- 工具函数

/**
 * 把「某天的步数」写进运动打卡（设备数据与打卡体系的衔接点）
 * ---------------------------------------------------------------------------
 * 规则：
 *   · 时长 = 步数 ÷ 100 步/分钟；热量 = MET 3.5 的步行 × 体重 × 时长（与手动打卡同一公式）；
 *   · 同一天只保留**一条**设备来源的步行打卡：已存在就更新，避免"导入一次 + 演示一次"
 *     同一天出现两条步行、热量被重复计算（实测踩过）；
 *   · 只认「日常步行 + 设备/演示 note」这一条，用户自己手动记的步行不受影响。
 * @returns {boolean} true = 新建，false = 覆盖更新
 */
function upsertStepLog(userId, date, steps, weightKg, note) {
  const minutes = Math.max(1, Math.round(steps / 100));
  const kcal = calcCalories(3.5, weightKg || 65, minutes, 'low');
  const exist = get(
    `SELECT id FROM workout_logs
      WHERE user_id = ? AND log_date = ? AND exercise_name = '日常步行'
        AND note IN ('设备导入的步数', '演示设备步数')
      ORDER BY id DESC LIMIT 1`,
    [userId, date],
  );
  if (exist) {
    run('UPDATE workout_logs SET duration_min = ?, calories = ?, note = ? WHERE id = ?', [minutes, kcal, note, exist.id]);
    return false;
  }
  run(
    `INSERT INTO workout_logs (user_id, log_date, exercise_name, category, duration_min, intensity, calories, note)
     VALUES (?,?,?,?,?,?,?,?)`,
    [userId, date, '日常步行', '有氧', minutes, 'low', kcal, note],
  );
  return true;
}

/** 构建 CSV 模板（前端可下载） */
function buildCsvTemplate() {
  return [
    'date,steps,restingHr,sleepHours,weightKg,activeMinutes,hrAvg,hrMax,hrMin',
    `${today()},8600,64,7.2,75.2,45,78,132,58`,
    `${shiftDate(today(), -1)},7400,65,6.8,,38,75,128,60`,
  ].join('\n');
}

/** 极简 CSV 解析：支持逗号/制表符分隔、双引号包裹、首行表头自动映射 */
function parseCsv(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const split = (line) => {
    const delimiter = line.includes('\t') ? '\t' : ',';
    const out = [];
    let cur = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') inQuote = !inQuote;
      else if (ch === delimiter && !inQuote) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const header = split(lines[0]).map((h) => h.replace(/\s|_/g, '').toLowerCase());
  const alias = {
    date: 'date', 日期: 'date',
    steps: 'steps', 步数: 'steps',
    restinghr: 'restingHr', 静息心率: 'restingHr', 心率: 'restingHr', hr: 'restingHr', heartrate: 'restingHr',
    sleephours: 'sleepHours', 睡眠: 'sleepHours', 睡眠时长: 'sleepHours', sleep: 'sleepHours',
    weightkg: 'weightKg', 体重: 'weightKg', weight: 'weightKg',
    activeminutes: 'activeMinutes', 活动时长: 'activeMinutes', minutes: 'activeMinutes',
    // 当天心率统计（Apple 健康 / 手环 App 导出）：表头去空格并转小写后是 hravg / hrmax / hrmin，
    // 必须显式映射回驼峰字段；否则 row 里留下的是小写 key，取值永远拿到 null（踩过这个坑）
    hravg: 'hrAvg', avghr: 'hrAvg', 平均心率: 'hrAvg',
    hrmax: 'hrMax', maxhr: 'hrMax', 最高心率: 'hrMax',
    hrmin: 'hrMin', minhr: 'hrMin', 最低心率: 'hrMin',
  };
  const keys = header.map((h) => alias[h] || h);

  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row = {};
    keys.forEach((k, i) => {
      if (cells[i] !== undefined) row[k] = cells[i];
    });
    return row;
  });
}

/** JSON 解析：接受数组，或 {records:[...]} / {data:[...]} */
function parseJson(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new BizError('JSON 格式不正确');
  }
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.records)) return j.records;
  if (Array.isArray(j.data)) return j.data;
  throw new BizError('JSON 里没有找到数组数据（支持数组或 {records:[]}）');
}

/** 日期归一化：支持 2026-10-21 / 2026/10/21 / 20261021 / 时间戳 */
function normalizeDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e12) {
    const d = new Date(n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

/** 数值归一化：无法解析返回 null */
function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default router;
