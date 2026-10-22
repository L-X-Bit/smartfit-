/**
 * 设备数据解析与写库（服务层）
 * ===========================================================================
 * 为什么单独抽这一个文件：
 *   「导入 CSV/JSON」和「自动同步推送」其实是**同一件事的两种入口**——
 *   都是拿到若干条「每日健康指标」，都要做 ① 解析 ② 归一化 ③ 写身体数据 ④ 步数折算打卡。
 *   如果两边各写一遍，早晚会出现「导入能算热量、自动同步却不算」这类不一致的 bug。
 *   所以这里把公共逻辑收口，路由层只负责鉴权、校验和返回。
 *
 * 对外提供：
 *   · buildCsvTemplate()                        —— 给前端的 CSV 模板
 *   · parseCsv(text) / parseJson(text)          —— 文本 → 原始行
 *   · normalizeRows(rows, limit)                —— 原始行 → 干净的行（带别名、缺列跳过）
 *   · applyDailyRows(userId, rows, opts)        —— 真正写库（身体数据 + 步数打卡）
 *   · recordDeviceSync(userId, info)            —— 写一条同步历史
 *
 * 数据口径（讲解要点）：
 *   · 体重 / 静息心率 / 睡眠 → 写进 body_records（一天一条，已存在就更新，不会重复堆积）；
 *   · 步数 → 按 100 步/分钟折算时长，用统一的 MET 公式算热量，写进 workout_logs。
 *     同一天只保留一条「设备来源」的日常步行，避免导入一次 + 同步一次导致热量翻倍。
 */
import { get, run, today, shiftDate } from '../../db/index.js';
import { calcCalories } from '../../utils/health.js';
import { BizError } from '../../utils/response.js';

/** CSV 模板（前端「下载模板」用的就是这份，保证和后端解析规则永远一致） */
export function buildCsvTemplate() {
  return [
    'date,steps,restingHr,sleepHours,weightKg,activeMinutes,hrAvg,hrMax,hrMin',
    `${today()},8600,64,7.2,75.2,45,78,132,58`,
    `${shiftDate(today(), -1)},7400,65,6.8,,38,75,128,60`,
  ].join('\n');
}

/**
 * 极简 CSV 解析
 * ---------------------------------------------------------------------------
 * 只做本项目真正需要的三件事，不引入重量级依赖：
 *   1. 支持逗号 / 制表符两种分隔符（从 Excel 复制出来常常是制表符）；
 *   2. 支持双引号包裹（值里带逗号也不会切错）；
 *   3. 首行表头自动映射：大小写、空格、下划线、中英文别名都能认。
 */
export function parseCsv(text) {
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

/** JSON 解析：接受数组，或 {records:[...]} / {data:[...]} / {rows:[...]} */
export function parseJson(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new BizError('JSON 格式不正确');
  }
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.records)) return j.records;
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j.rows)) return j.rows;
  throw new BizError('JSON 里没有找到数组数据（支持数组或 {records:[]}）');
}

/** 日期归一化：支持 2026-10-21 / 2026/10/21 / 20261021 / 时间戳 */
export function normalizeDate(v) {
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
export function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 原始行 → 干净行
 * 别名兼容：resting_hr / hr / sleep / weight / 平均心率……（iPhone 快捷指令里手写 key 也认）
 * @param {any[]} rows 原始行
 * @param {number} limit 最多处理多少行（防止一次灌入过量数据）
 */
export function normalizeRows(rows, limit = 400) {
  const clean = [];
  for (const r of rows.slice(0, limit)) {
    const date = normalizeDate(r.date ?? r.日期 ?? r.day);
    if (!date) continue;
    const item = {
      date,
      steps: toNum(r.steps ?? r.步数 ?? r.stepCount),
      restingHr: toNum(r.restingHr ?? r.resting_hr ?? r.hr ?? r.静息心率 ?? r.heartRate),
      sleepHours: toNum(r.sleepHours ?? r.sleep_hours ?? r.sleep ?? r.睡眠),
      weightKg: toNum(r.weightKg ?? r.weight_kg ?? r.weight ?? r.体重),
      activeMinutes: toNum(r.activeMinutes ?? r.active_minutes ?? r.minutes ?? r.活动时长),
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
  return clean;
}

/**
 * 把「某天的步数」写进运动打卡（设备数据与打卡体系的衔接点）
 * ---------------------------------------------------------------------------
 * 规则：
 *   · 时长 = 步数 ÷ 100 步/分钟；热量 = MET 3.5 的步行 × 体重 × 时长（与手动打卡同一公式）；
 *   · 同一天只保留**一条**设备来源的步行打卡：已存在就更新，避免"导入一次 + 演示一次"
 *     同一天出现两条步行、热量被重复计算（实测踩过）；
 *   · 只认「日常步行 + 设备来源 note」这一条，用户自己手动记的步行不受影响。
 * @param {string[]} extraNotes 除默认两条之外的设备来源 note（自动同步会传自己的标记）
 * @returns {boolean} true = 新建，false = 覆盖更新
 */
export function upsertStepLog(userId, date, steps, weightKg, note, extraNotes = []) {
  const minutes = Math.max(1, Math.round(steps / 100));
  const kcal = calcCalories(3.5, weightKg || 65, minutes, 'low');
  const deviceNotes = ['设备导入的步数', '演示设备步数', ...extraNotes];
  const placeholders = deviceNotes.map(() => '?').join(',');
  const exist = get(
    `SELECT id FROM workout_logs
      WHERE user_id = ? AND log_date = ? AND exercise_name = '日常步行'
        AND note IN (${placeholders})
      ORDER BY id DESC LIMIT 1`,
    [userId, date, ...deviceNotes],
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

/**
 * 批量写库：身体数据（体重/静息心率/睡眠）+ 步数折算的步行打卡
 * @param {number} userId 用户 id
 * @param {ReturnType<typeof normalizeRows>} rows 干净行
 * @param {{note?:string, stepNote?:string}} [opts] 写库备注，用于区分「导入 / 自动同步」来源
 * @returns {{written:number, updated:number}}
 */
export function applyDailyRows(userId, rows, opts = {}) {
  const bodyNote = opts.note || '由设备导入';
  const stepNote = opts.stepNote || '设备导入的步数';
  let written = 0;
  let updated = 0;

  for (const it of rows) {
    const exist = get('SELECT id FROM body_records WHERE user_id = ? AND record_date = ? ORDER BY id DESC LIMIT 1', [userId, it.date]);

    if (it.weightKg || it.restingHr || it.sleepHours) {
      const base = exist
        ? get('SELECT * FROM body_records WHERE id = ?', [exist.id])
        : get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 1', [userId]);
      const weight = it.weightKg ?? base?.weight_kg ?? 65;
      if (exist) {
        run(
          `UPDATE body_records SET weight_kg = ?, resting_hr = COALESCE(?, resting_hr), sleep_hours = COALESCE(?, sleep_hours), note = COALESCE(NULLIF(note,''), ?) WHERE id = ?`,
          [weight, it.restingHr, it.sleepHours, bodyNote, exist.id],
        );
      } else {
        run(
          'INSERT INTO body_records (user_id, record_date, weight_kg, resting_hr, sleep_hours, note) VALUES (?,?,?,?,?,?)',
          [userId, it.date, weight, it.restingHr, it.sleepHours, bodyNote],
        );
      }
      written += 1;
    }

    // 步数折算为一次步行打卡（时长按 100 步/分钟估算，热量走统一 MET 公式）
    if (it.steps && it.steps > 0) {
      const body = get('SELECT weight_kg FROM body_records WHERE user_id = ? ORDER BY record_date DESC LIMIT 1', [userId]);
      if (upsertStepLog(userId, it.date, it.steps, body?.weight_kg, stepNote, [stepNote])) written += 1;
      else updated += 1;
    }
  }

  return { written, updated };
}

/**
 * 写一条同步历史（设备同步页的「同步历史」列表 + 一周图表都读这张表）
 * @param {number} userId
 * @param {{source:string, deviceName?:string, syncType?:string, payload?:object, summary?:string, recordCount?:number}} info
 * @returns {number} 新记录 id
 */
export function recordDeviceSync(userId, info) {
  return run(
    `INSERT INTO device_syncs (user_id, source, device_name, sync_type, payload, summary, record_count)
     VALUES (?,?,?,?,?,?,?)`,
    [
      userId,
      info.source,
      info.deviceName || '未知设备',
      info.syncType || 'daily',
      JSON.stringify(info.payload || {}),
      info.summary || '',
      info.recordCount || 0,
    ],
  ).lastInsertRowid;
}
