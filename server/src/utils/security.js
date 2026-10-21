/**
 * 密码与令牌工具
 * ---------------------------------------------------------------------------
 * 安全设计（讲解要点）：
 *   1. 密码使用 bcrypt（cost=10）加盐哈希，数据库只存哈希值，即使库被拖走也无法还原明文；
 *   2. 登录态使用 JWT（HS256），无状态、可水平扩展，前端存在 localStorage；
 *   3. 令牌里只放 userId 与 nickname，不放敏感信息。
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/** 生成密码哈希 */
export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

/** 校验密码 */
export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

/** 签发 JWT */
export function signToken(user) {
  return jwt.sign({ uid: user.id, nickname: user.nickname }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

/** 校验 JWT，失败返回 null（由中间件决定如何响应） */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch {
    return null;
  }
}
