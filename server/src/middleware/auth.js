/**
 * 鉴权中间件：从 Authorization: Bearer <token> 解析登录用户
 * 通过后在 req.user 上挂载 { id, nickname }，后续路由直接使用
 */
import { verifyToken } from '../utils/security.js';
import { fail } from '../utils/response.js';
import { get } from '../db/index.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return fail(res, '未登录或登录已过期，请重新登录', 401);

  const payload = verifyToken(token);
  if (!payload) return fail(res, '登录凭证无效，请重新登录', 401);

  // 二次校验用户是否仍存在（防止账号被删除后旧 token 仍可用）
  const user = get('SELECT id, username, nickname, avatar, gender, birth_date, height_cm, goal, weekly_target FROM users WHERE id = ?', [
    payload.uid,
  ]);
  if (!user) return fail(res, '用户不存在', 401);

  req.user = user;
  return next();
}

/**
 * 可选鉴权：社区列表等公开接口需要「当前用户是否点过赞」的信息，
 * 但未登录也应能浏览，因此这里解析失败也不报错。
 */
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = get('SELECT id, username, nickname, avatar FROM users WHERE id = ?', [payload.uid]);
      if (user) req.user = user;
    }
  }
  return next();
}
