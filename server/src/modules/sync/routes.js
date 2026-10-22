/**
 * 自动同步（免导出 / 免上传）
 * ===========================================================================
 * 解决问题（用户原话）：
 *   「不要每次先把数据下载下来、再转成 csv/zip 上传，能不能自动同步？」
 *
 * 现实约束先说清楚（技术文档可讲）：
 *   · 浏览器**拿不到** Apple 健康 / 华为运动健康 / 小米运动里的历史数据——
 *     iOS 至今没给网页开放 HealthKit，各家云 API 又要企业资质 + OAuth 审核；
 *   · 所以真正的「自动」只能从**能拿到系统数据的那一端**发起推送：
 *       iPhone → 系统自带「快捷指令」定时读取健康 App（无需装任何第三方 App）
 *       Android→ Chrome 蓝牙实时读（已有）或免费的 HTTP Shortcuts App
 *       电脑  → tools/health-sync.mjs 监听目录，直接啃「健康」导出文件，彻底不用转 CSV
 *
 * 本模块提供的东西：
 *   ① 令牌管理（登录态）：创建 / 列表 / 撤销。令牌明文只在创建时返回一次，库里只存 SHA-256。
 *   ② 推送接口（令牌鉴权）：POST /api/sync/push（JSON）与 GET /api/sync/push（查询参数）。
 *      GET 版本是刻意设计的——iPhone 快捷指令里「获取 URL 内容」只填一个网址就能跑完，
 *      不用拼 JSON、不用设请求头，普通人照着图就能配好。
 *   ③ 自助配置接口（登录态）：GET /api/sync/setup 把推送地址、模板、命令一次吐给前端，
 *      界面上的「一键复制」全部来自这里，避免文档和代码对不上。
 *
 * 幂等性：写库复用 devices/service.js 的 applyDailyRows——
 *   同一天重复推送只会更新，不会堆出一堆重复记录（快捷指令每天跑、偶尔重跑都安全）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { all, get, run, today } from '../../db/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireSyncToken } from '../../middleware/syncAuth.js';
import { rateLimit } from '../../middleware/common.js';
import { generateSyncToken, hashSyncToken, tokenHint } from '../../utils/syncToken.js';
import { applyDailyRows, buildCsvTemplate, normalizeRows, recordDeviceSync } from '../devices/service.js';

const router = Router();

/** 推送限流：设备/脚本正常一天推送几次，给到 120 次/分钟足够宽松又能挡住刷接口 */
const pushLimit = rateLimit({ limit: 120, windowMs: 60_000 });
/** 令牌管理限流：防止被恶意反复创建 */
const tokenLimit = rateLimit({ limit: 20, windowMs: 60_000 });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 算出发给设备用的**绝对**推送地址
 * ---------------------------------------------------------------------------
 * 线上是 Render 反向代理，req.protocol 会是 http，必须优先读 X-Forwarded-Proto，
 * 否则快捷指令拿到的 http 地址会被 iOS 的 ATS 拦掉（真实踩过的坑）。
 */
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// ============================================================ ① 令牌管理（登录态）

/** 新建令牌 */
const createTokenSchema = z.object({
  /** 来源备注，帮用户记住这枚令牌给了哪台设备 */
  name: z.string().max(40).optional(),
});

router.post(
  '/tokens',
  requireAuth,
  tokenLimit,
  asyncHandler((req, res) => {
    const { name } = createTokenSchema.parse(req.body || {});
    const plain = generateSyncToken();
    const id = run('INSERT INTO sync_tokens (user_id, name, token_hash, token_hint) VALUES (?,?,?,?)', [
      req.user.id,
      name || '未命名设备',
      hashSyncToken(plain),
      tokenHint(plain),
    ]).lastInsertRowid;

    // 明文只在这里返回一次：前端必须让用户立刻复制走
    return ok(
      res,
      {
        id,
        name: name || '未命名设备',
        token: plain,
        hint: tokenHint(plain),
        pushUrl: `${originOf(req)}/api/sync/push`,
      },
      '令牌已生成，请立刻复制保存（关闭后不再显示完整令牌）',
    );
  }),
);

/** 令牌列表（只返回摘要，永远不回显明文） */
router.get(
  '/tokens',
  requireAuth,
  asyncHandler((req, res) => {
    const rows = all('SELECT * FROM sync_tokens WHERE user_id = ? ORDER BY revoked ASC, id DESC LIMIT 20', [req.user.id]);
    return ok(
      res,
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        hint: r.token_hint,
        pushCount: r.push_count,
        lastUsedAt: r.last_used_at,
        revoked: !!r.revoked,
        createdAt: r.created_at,
      })),
    );
  }),
);

/** 撤销令牌（保留记录以便审计，不做物理删除） */
router.delete(
  '/tokens/:id',
  requireAuth,
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new BizError('令牌 id 不合法');
    const exist = get('SELECT id FROM sync_tokens WHERE id = ? AND user_id = ?', [id, req.user.id]);
    if (!exist) throw new BizError('令牌不存在', 404);
    run('UPDATE sync_tokens SET revoked = 1 WHERE id = ?', [id]);
    return ok(res, { id, revoked: true }, '令牌已撤销，对应设备将无法再推送');
  }),
);

/**
 * 自助配置：把「怎么配」需要的东西一次性给前端
 * 前端的复制按钮全部读这里，文档和实现不会脱节。
 */
router.get(
  '/setup',
  requireAuth,
  asyncHandler((req, res) => {
    const origin = originOf(req);
    const tokens = all('SELECT * FROM sync_tokens WHERE user_id = ? AND revoked = 0 ORDER BY id DESC LIMIT 10', [req.user.id]);
    const hasToken = tokens.length > 0;

    const jsonSample = {
      // 快捷指令 / 脚本推送的 JSON 结构（字段都能省，只传有的那几个）
      device: 'iPhone 快捷指令',
      date: today(),
      metrics: { steps: 8600, restingHr: 64, sleepHours: 7.2, weightKg: 75.2, hrAvg: 78, hrMax: 132, hrMin: 58 },
    };

    return ok(res, {
      origin,
      pushUrl: `${origin}/api/sync/push`,
      pingUrl: `${origin}/api/sync/ping`,
      /** GET 版一键推送地址（token 占位，前端替换成用户自己的令牌） */
      getUrlSample: `${origin}/api/sync/push?token=<你的令牌>&steps=8600&restingHr=64&sleepHours=7.2`,
      jsonSample,
      jsonSampleText: JSON.stringify(jsonSample, null, 2),
      csvTemplate: buildCsvTemplate(),
      /** 电脑端监听脚本命令（Windows 版路径示例） */
      watchCommand: 'node tools/health-sync.mjs --watch "%USERPROFILE%\\iCloudDrive\\智练同步"',
      exportCommand: 'node tools/health-sync.mjs --once "导出.zip"',
      tokenCount: tokens.length,
      hasToken,
    });
  }),
);

// ============================================================ ② 推送（令牌鉴权）

/**
 * 可选数值字段
 * ---------------------------------------------------------------------------
 * 用 nullish()（= optional + nullable）而不是 optional()：
 * 手写 JSON 的调用方常把"这项没有"写成 null（例如 {"steps": 8600, "sleepHours": null}），
 * 如果只允许 optional，zod 会直接报"Expected number, received null"，
 * 用户看到的是一句看不懂的参数校验失败。这里一律接受 null，交给后面统一当"没填"处理。
 */
const numOpt = (min, max) => z.number().min(min).max(max).nullish();

const metricsSchema = z.object({
  date: z.string().regex(DATE_RE).nullish(),
  steps: numOpt(0, 200000),
  restingHr: numOpt(20, 250),
  sleepHours: numOpt(0, 24),
  weightKg: numOpt(20, 400),
  activeMinutes: numOpt(0, 1440),
  hrAvg: numOpt(20, 250),
  hrMax: numOpt(20, 250),
  hrMin: numOpt(20, 250),
});

const pushSchema = z.object({
  /** 来源备注，会写进「同步历史」，便于区分是哪台设备推的 */
  device: z.string().max(60).optional(),
  date: z.string().regex(DATE_RE).optional(),
  metrics: metricsSchema.optional(),
  /** 批量补历史：数组里每行一个日期（字段别名同上，兼容 iPhone 手写 key） */
  rows: z.array(z.any()).max(500).optional(),
  /** 心率会话（可选）：有就顺手记一条，并可写当日静息心率 */
  heartRate: z
    .object({
      avg: z.number().min(20).max(250),
      max: z.number().min(20).max(250),
      min: z.number().min(20).max(250),
      durationSec: z.number().min(1).max(36000),
      date: z.string().regex(DATE_RE).optional(),
      saveAsRestingHr: z.boolean().optional(),
    })
    .optional(),
  /** true = 只回显将要写入什么，不落库（快捷指令调试时很有用） */
  dryRun: z.boolean().optional(),
});

/**
 * 把一次推送归一化成「每日指标行」
 * @param {z.infer<typeof pushSchema>} d
 * @param {string} fallbackDate 缺省日期（一般是今天）
 */
function toCleanRows(d, fallbackDate) {
  /**
   * 按日期合并
   * -------------------------------------------------------------------------
   * 关键点（踩过的坑）：一次推送里可能既有 metrics/rows，又带 heartRate，
   * 两者日期相同。如果直接 {...旧, ...新} 合并，心率会话里那些「没有的字段」
   * 是 null，会把刚解析出来的步数/睡眠覆盖成 null，数据就悄悄丢了。
   * 所以这里只让**有值**的字段覆盖，null/undefined 一律视为"这次没说"。
   */
  const byDate = new Map();
  const mergeInto = (row) => {
    const cur = byDate.get(row.date) || {
      date: row.date,
      steps: null,
      restingHr: null,
      sleepHours: null,
      weightKg: null,
      activeMinutes: null,
      hrAvg: null,
      hrMax: null,
      hrMin: null,
    };
    for (const [k, v] of Object.entries(row)) {
      if (k !== 'date' && v !== null && v !== undefined) cur[k] = v;
    }
    byDate.set(row.date, cur);
  };

  // 批量行
  if (d.rows?.length) normalizeRows(d.rows, 400).forEach(mergeInto);

  // 单日指标
  if (d.metrics) {
    const date = d.metrics.date || d.date || fallbackDate;
    normalizeRows([{ ...d.metrics, date }], 1).forEach(mergeInto);
  }

  // 心率会话 → 折算成当天的 hrAvg / hrMax / hrMin（可选把平均心率记为静息心率）
  if (d.heartRate) {
    const date = d.heartRate.date || d.date || fallbackDate;
    mergeInto({
      date,
      restingHr: d.heartRate.saveAsRestingHr ? Math.round(d.heartRate.avg) : null,
      hrAvg: Math.round(d.heartRate.avg),
      hrMax: Math.round(d.heartRate.max),
      hrMin: Math.round(d.heartRate.min),
    });
  }

  // 只保留真的有值的日期，按日期升序（写库顺序稳定，便于看日志）
  return [...byDate.values()]
    .filter((r) => r.steps !== null || r.restingHr !== null || r.sleepHours !== null || r.weightKg !== null || r.hrAvg !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 真正干活：写库 + 记同步历史（POST / GET 两个入口共用） */
function handlePush(req, res, payload, deviceName) {
  const d = pushSchema.parse(payload || {});
  const clean = toCleanRows(d, today());
  if (!clean.length) {
    throw new BizError('没有可用数据：请提供 metrics（单日指标）或 rows（多日数组）');
  }

  if (d.dryRun) {
    return ok(res, { preview: clean.slice(0, 20), total: clean.length, written: 0 }, `解析到 ${clean.length} 天数据，dryRun 未写库`);
  }

  const { written, updated } = applyDailyRows(req.user.id, clean, {
    note: '由设备自动同步',
    stepNote: '自动同步的步数',
  });

  const first = clean[0].date;
  const last = clean[clean.length - 1].date;
  const range = first === last ? first : `${first} ~ ${last}`;
  const summary = `自动同步 ${clean.length} 天（${range}）· 写入 ${written} 条${updated ? `、更新 ${updated} 条打卡` : ''}`;
  const id = recordDeviceSync(req.user.id, {
    source: 'auto',
    deviceName: d.device || deviceName || '自动同步',
    syncType: 'daily',
    payload: { rows: clean.slice(0, 200) },
    summary,
    recordCount: written,
  });

  return ok(res, { id, summary, written, updated, days: clean.map((c) => c.date) }, summary);
}

/** JSON 推送（脚本 / 快捷指令用「获取 URL 内容 + POST + JSON 请求体」） */
router.post(
  '/push',
  requireSyncToken,
  pushLimit,
  asyncHandler((req, res) => handlePush(req, res, req.body, req.syncToken?.name)),
);

/**
 * 查询参数推送（iPhone 快捷指令最省事的用法：一个网址搞定）
 * 例：/api/sync/push?token=sft_xxx&steps=8600&restingHr=64&sleepHours=7.2
 * 说明：只支持单日；要补历史请用 POST + rows。
 */
router.get(
  '/push',
  requireSyncToken,
  pushLimit,
  asyncHandler((req, res) => {
    const q = req.query || {};
    const metrics = {
      date: q.date,
      steps: pickNum(q.steps),
      restingHr: pickNum(q.restingHr ?? q.resting_hr ?? q.hr),
      sleepHours: pickNum(q.sleepHours ?? q.sleep),
      weightKg: pickNum(q.weightKg ?? q.weight),
      activeMinutes: pickNum(q.activeMinutes),
      hrAvg: pickNum(q.hrAvg),
      hrMax: pickNum(q.hrMax),
      hrMin: pickNum(q.hrMin),
    };
    return handlePush(req, res, { device: q.device, date: q.date, metrics, dryRun: q.dryRun === '1' || q.dryRun === 'true' }, req.syncToken?.name);
  }),
);

/** 探活：设备/脚本先用它验证令牌是否有效（快捷指令里也可以先跑这一步确认配对了） */
router.get(
  '/ping',
  requireSyncToken,
  asyncHandler((req, res) => {
    const last = get('SELECT source, device_name, summary, created_at FROM device_syncs WHERE user_id = ? ORDER BY id DESC LIMIT 1', [
      req.user.id,
    ]);
    return ok(
      res,
      {
        ok: true,
        user: req.user.nickname || req.user.username,
        tokenName: req.syncToken?.name,
        lastSync: last ? { source: last.source, deviceName: last.device_name, summary: last.summary, createdAt: last.created_at } : null,
        today: today(),
      },
      `令牌有效，可以推送${req.user.nickname ? `（${req.user.nickname} 的数据）` : ''}`,
    );
  }),
);

/** 查询参数里的数字：空值/非法值一律当"没填"，交给校验与 not-null 判断处理 */
function pickNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export default router;
