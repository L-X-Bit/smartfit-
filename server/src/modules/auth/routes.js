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
import { requireAuth } from '../../middleware/auth.js';
import { calcBMI, calcAge } from '../../utils/health.js';

const router = Router();

/** 注册参数校验规则 */
const registerSchema = z.object({
  username: z.string().min(3, '账号至少 3 位').max(20, '账号最多 20 位').regex(/^[a-zA-Z0-9_]+$/, '账号只能包含字母、数字和下划线'),
  password: z.string().min(6, '密码至少 6 位').max(32, '密码最多 32 位'),
  nickname: z.string().min(1, '请填写昵称').max(20),
});

router.post(
  '/register',
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
    return ok(res, { token: signToken(user), user: publicUser(user) }, '注册成功，已自动登录');
  }),
);

/** 登录参数校验 */
const loginSchema = z.object({
  username: z.string().min(1, '请输入账号'),
  password: z.string().min(1, '请输入密码'),
});

router.post(
  '/login',
  asyncHandler((req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const user = get('SELECT * FROM users WHERE username = ?', [username]);
    // 统一提示「账号或密码错误」，避免账号枚举攻击
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new BizError('账号或密码错误', 401);
    }
    return ok(res, { token: signToken(user), user: publicUser(user) }, '登录成功');
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
