/**
 * 鉴权与用户档案路由
 * ---------------------------------------------------------------------------
 * POST /api/auth/register  注册
 * POST /api/auth/login     登录（返回 JWT）
 * GET  /api/auth/me        当前用户（含身体档案）
 * PUT  /api/auth/profile   更新档案（身高/性别/生日/目标/每周训练天数）
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, BizError } from '../../utils/response.js';
import { hashPassword, verifyPassword, signToken } from '../../utils/security.js';
import { get, run, all } from '../../db/index.js';
import { requireAuth, AUTH_COOKIE } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/common.js';
import { calcBMI, calcAge } from '../../utils/health.js';
import { config } from '../../config/index.js';

const router = Router();

/**
 * 登录失败锁定（验收报告 BUG-6：演示密码 123456、注册接口可随意调用）
 * ---------------------------------------------------------------------------
 * 只做「暴力破解挡住 + 注册限流」，不改变演示体验：
 *   · 同一 IP + 账号 10 分钟内连续失败 5 次 → 锁定 5 分钟，返回 429 并给出剩余秒数；
 *   · 登录接口本身再加一层每分钟 20 次的限流，注册接口每小时 5 次（防刷号）。
 * 内存实现足够（单实例部署），多实例可换 Redis。
 */
const loginFailures = new Map(); // key -> { count, firstAt, lockedUntil }
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;

function failKey(req, username) {
  return `${req.ip}:${String(username || '').toLowerCase()}`;
}

function assertNotLocked(key) {
  const rec = loginFailures.get(key);
  if (!rec?.lockedUntil) return;
  if (Date.now() < rec.lockedUntil) {
    const seconds = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    throw new BizError(`密码错误次数过多，请 ${seconds} 秒后再试（也可换用演示账号 demo / 123456）`, 429);
  }
  loginFailures.delete(key);
}

function recordFailure(key) {
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (!rec || now - rec.firstAt > FAIL_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  rec.count += 1;
  if (rec.count >= FAIL_LIMIT) {
    rec.lockedUntil = now + LOCK_MS;
    console.warn(`[鉴权] 账号连续失败 ${rec.count} 次，已锁定 5 分钟：${key}`);
  }
}

function clearFailures(key) {
  loginFailures.delete(key);
}

/** 注册密码强度：至少 8 位且同时含字母与数字（仅注册校验，老账号登录不受影响） */
const passwordRule = z
  .string()
  .min(8, '密码至少 8 位')
  .max(32, '密码最多 32 位')
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), '密码需同时包含字母和数字');

/**
 * 把登录态写进 HttpOnly Cookie
 * ---------------------------------------------------------------------------
 * 为什么不把 token 交给 localStorage 保管（验收报告里的一条低危问题）：
 *   localStorage 对页面里任何 JS 都是明文可读的，一旦出现 XSS（比如某处把用户昵称
 *   直接 v-html 出来），攻击者一行 `localStorage.getItem('smartfit_token')` 就能带走登录态。
 *   HttpOnly Cookie 由浏览器保管，JS 读不到，配合 app.js 里的 CSP 双重收口。
 * 兼容性：响应体里仍然返回 token，命令行脚本 / 自动化测试可以直接用 Bearer 头调用。
 */
function setAuthCookie(req, res, token) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  const attrs = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 3600}`,
  ];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/** 注册参数校验规则 */
const registerSchema = z.object({
  username: z.string().min(3, '账号至少 3 位').max(20, '账号最多 20 位').regex(/^[a-zA-Z0-9_]+$/, '账号只能包含字母、数字和下划线'),
  password: passwordRule,
  nickname: z.string().min(1, '请填写昵称').max(20),
});

router.post(
  '/register',
  // 防刷号：同一 IP 每小时最多 5 个账号（验证码方案需要额外服务，比赛环境用限流更轻）
  rateLimit({ limit: 5, windowMs: 60 * 60 * 1000 }),
  asyncHandler((req, res) => {
    const { username, password, nickname } = registerSchema.parse(req.body);
    if (get('SELECT id FROM users WHERE username = ?', [username])) {
      throw new BizError('该账号已被注册，请换一个', 409);
    }
    // 默认档案：性别未知、身高 170、目标保持、每周 3 练；用户登录后可在个人中心完善
    const id = run(
      `INSERT INTO users (username, password_hash, nickname, gender, height_cm, goal, weekly_target)
       VALUES (?,?,?,?,?,?,?)`,
      [username, hashPassword(password), nickname, 'unknown', 170, 'keep', 3],
    ).lastInsertRowid;

    const user = get('SELECT * FROM users WHERE id = ?', [id]);
    const token = signToken(user);
    setAuthCookie(req, res, token);
    return ok(res, { token, user: publicUser(user) }, '注册成功，已自动登录');
  }),
);

/** 登录参数校验 */
const loginSchema = z.object({
  username: z.string().min(1, '请输入账号'),
  password: z.string().min(1, '请输入密码'),
});

router.post(
  '/login',
  // 暴力破解防护：同一 IP 每分钟 20 次；账号维度还有「连续失败 5 次锁定 5 分钟」
  rateLimit({ limit: 20, windowMs: 60_000 }),
  asyncHandler((req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const key = failKey(req, username);
    assertNotLocked(key);

    const user = get('SELECT * FROM users WHERE username = ?', [username]);
    // 统一提示「账号或密码错误」，避免账号枚举攻击
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordFailure(key);
      throw new BizError('账号或密码错误', 401);
    }
    clearFailures(key);
    const token = signToken(user);
    setAuthCookie(req, res, token);
    return ok(res, { token, user: publicUser(user) }, '登录成功');
  }),
);

/** 退出登录：清掉 HttpOnly Cookie（前端同时也清本地缓存） */
router.post(
  '/logout',
  asyncHandler((req, res) => {
    res.append('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return ok(res, null, '已退出登录');
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler((req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const latest = get('SELECT * FROM body_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1', [req.user.id]);
    return ok(res, { ...publicUser(user), latestBody: latest || null });
  }),
);

/** 档案更新校验（所有字段可选，只更新传入项） */
const profileSchema = z.object({
  nickname: z.string().min(1).max(20).optional(),
  avatar: z.string().max(500).optional(),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '生日格式应为 YYYY-MM-DD').optional(),
  heightCm: z.number().min(100, '身高应大于 100cm').max(250, '身高应小于 250cm').optional(),
  goal: z.enum(['lose', 'gain', 'keep', 'shape']).optional(),
  weeklyTarget: z.number().int().min(1).max(7).optional(),
});

router.put(
  '/profile',
  requireAuth,
  asyncHandler((req, res) => {
    const p = profileSchema.parse(req.body);
    const fields = [];
    const values = [];
    const map = { nickname: 'nickname', avatar: 'avatar', gender: 'gender', birthDate: 'birth_date', heightCm: 'height_cm', goal: 'goal', weeklyTarget: 'weekly_target' };
    for (const [key, col] of Object.entries(map)) {
      if (p[key] !== undefined) {
        fields.push(`${col} = ?`);
        values.push(p[key]);
      }
    }
    if (!fields.length) throw new BizError('没有需要更新的字段');
    values.push(req.user.id);
    run(`UPDATE users SET ${fields.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`, values);

    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    return ok(res, publicUser(user), '资料已更新');
  }),
);

/** 公开用户字段（永远不要返回 password_hash） */
function publicUser(u) {
  const bmi = u.height_cm ? calcBMI(0, u.height_cm) : null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatar: u.avatar || '',
    gender: u.gender,
    birthDate: u.birth_date,
    age: calcAge(u.birth_date),
    heightCm: u.height_cm,
    goal: u.goal,
    weeklyTarget: u.weekly_target,
    createdAt: u.created_at,
    bmiHeightOnly: Boolean(bmi),
  };
}

export default router;
