/**
 * 自动同步令牌：生成与摘要
 * ===========================================================================
 * 为什么要有「令牌」这一层：
 *   iPhone 的「快捷指令」、电脑上的监听脚本都不是浏览器，没有登录态，
 *   也不该把账号密码写在快捷指令里（手机丢了 / 截图泄漏就完蛋）。
 *   所以给每个用户签发独立的「同步令牌」：
 *     · 只用于推送健康数据，不能改资料、不能读社交内容，权限最小；
 *     · 可以按来源起名（iPhone / 笔记本 / 平板），泄漏了单独撤销即可，不影响其它设备；
 *     · 服务端只保存 SHA-256 摘要，明文只在创建的那一刻返回一次——和存密码一个思路，
 *       即使数据库被拖走，也拿不到能用的令牌。
 */
import crypto from 'node:crypto';

/** 令牌前缀：肉眼一眼能认出「这是智练的同步令牌」，也方便日志里做脱敏 */
export const TOKEN_PREFIX = 'sft_';

/**
 * 生成一枚令牌明文
 * 24 字节随机数 → base64url（32 字符），熵足够高，不会被猜中
 * @returns {string} 形如 sft_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */
export function generateSyncToken() {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
}

/**
 * 计算令牌摘要（存库、比对都用它）
 * @param {string} plain 令牌明文
 * @returns {string} 64 位十六进制字符串
 */
export function hashSyncToken(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

/** 取令牌明文的前若干位，界面上用来区分「是哪一枚」（不足以还原令牌） */
export function tokenHint(plain) {
  return String(plain).slice(0, TOKEN_PREFIX.length + 6);
}
