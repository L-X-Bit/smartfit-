/**
 * 鉴权中间件：从 HttpOnly Cookie 或 Authorization: Bearer <token> 解析登录用户
 * ---------------------------------------------------------------------------
 * 为什么现在优先用 Cookie（验收报告里「token 明文存 localStorage，XSS 风险」那条）：
 *   · Cookie 设 HttpOnly 后，页面上的任何 JS（包括被注入的第三方脚本）都读不到 token，
 *     即使出现 XSS 也偷不走登录态；localStorage 里的 token 则是随手 `localStorage.getItem` 就能拿。
 *   · 同时继续支持 `Authorization: Bearer`，因为命令行脚本 / 自动化测试 / 第三方调用方都用它，
 *     两套并存、Cookie 优先，向后兼容。
 * Cookie 名固定为 sft_token，属性：HttpOnly + SameSite=Lax（+ https 下 Secure）。
 */
import { verifyToken } from '../utils/security.js';
import { fail } from '../utils/response.js';
import { get } from '../db/index.js';

export const AUTH_COOKIE = 'sft_token';

/** 极简 Cookie 解析（不引入 cookie-parser，减少依赖面） */
export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/** 取出本次请求的登录令牌：Cookie 优先，其次 Authorization 头 */
export function extractToken(req) {
  const fromCookie = readCookie(req, AUTH_COOKIE);
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function requireAuth(req, res, next) {
  const token = extractToken(req);
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
  const token = extractToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = get('SELECT id, username, nickname, avatar FROM users WHERE id = ?', [payload.uid]);
      if (user) req.user = user;
    }
  }
  return next();
}
