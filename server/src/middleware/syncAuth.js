/**
 * 同步令牌鉴权中间件
 * ===========================================================================
 * 与 requireAuth（JWT 登录态）并列的第二套鉴权，专门给「设备 / 脚本」用：
 *   · 请求头 X-Sync-Token: sft_xxx      ← 推荐（不会出现在日志 URL 里）
 *   · 请求头 Authorization: Bearer sft_xxx
 *   · 查询参数 ?token=sft_xxx           ← 兜底：iPhone 快捷指令里「获取 URL 内容」不填请求头最省事
 *
 * 校验通过后：
 *   req.user  = { id, username, nickname }（下游业务代码完全不用区分是登录还是令牌）
 *   req.syncToken = 令牌记录（用于更新使用时间/次数、写来源备注）
 *
 * 安全细节：每次使用都会累加 push_count 并记录 last_used_at，
 * 用户可以在「设备同步」页看到某枚令牌最近什么时候用过——异常时一眼能看出来。
 */
import { get, run } from '../db/index.js';
import { fail } from '../utils/response.js';
import { hashSyncToken } from '../utils/syncToken.js';

/** 从三种来源里取出令牌明文 */
export function extractSyncToken(req) {
  const header = String(req.headers['x-sync-token'] || '').trim();
  if (header) return header;

  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    const bearer = auth.slice(7).trim();
    // 只有 sft_ 前缀的才当成同步令牌；否则是普通 JWT，交给 requireAuth 处理
    if (bearer.startsWith('sft_')) return bearer;
  }
  const queryToken = String(req.query?.token || '').trim();
  return queryToken || '';
}

export function requireSyncToken(req, res, next) {
  const plain = extractSyncToken(req);
  if (!plain) {
    return fail(res, '缺少同步令牌：请在「设备同步 → 自动同步」里生成，并放到请求头 X-Sync-Token', 401);
  }

  const row = get('SELECT * FROM sync_tokens WHERE token_hash = ? AND revoked = 0', [hashSyncToken(plain)]);
  if (!row) return fail(res, '同步令牌无效或已被撤销，请重新生成', 401);

  const user = get('SELECT id, username, nickname FROM users WHERE id = ?', [row.user_id]);
  if (!user) return fail(res, '令牌所属用户不存在', 401);

  // 记录使用情况（失败不影响主流程）
  try {
    run("UPDATE sync_tokens SET last_used_at = datetime('now','localtime'), push_count = push_count + 1 WHERE id = ?", [row.id]);
  } catch {
    /* 统计失败不该阻断数据同步 */
  }

  req.syncToken = row;
  req.user = user;
  return next();
}
