/**
 * 数据库访问层
 * ---------------------------------------------------------------------------
 * 技术选型说明（讲解要点）：
 *   - 使用 Node.js 22.5+ 内置的 `node:sqlite`，零外部依赖、零安装、单文件数据库，
 *     评审克隆代码后 `npm install && npm run init:db` 即可跑通，无需另装 MySQL；
 *   - 同时封装了 get/all/run/tx 四个方法，业务代码不出现任何 SQL 拼接细节以外的
 *     数据库 API，将来若迁移到 MySQL/PostgreSQL，只需替换本文件实现（仓储层隔离）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 确保数据库文件所在目录存在 */
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

/** 全局唯一的数据库连接（SQLite 单文件，进程内共享即可） */
export const db = new DatabaseSync(config.dbFile);

// 打开外键约束（SQLite 默认关闭）与 WAL 日志模式（提升并发读性能）
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

/**
 * 执行建表脚本（幂等：全部使用 CREATE TABLE IF NOT EXISTS）
 */
export function initSchema() {
  const sql = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
  db.exec(sql);
}

/**
 * 查询单行
 * @param {string} sql 带 ? 占位符的 SQL
 * @param {any[]} params
 */
export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

/**
 * 查询多行
 */
export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

/**
 * 执行写操作，返回 { changes, lastInsertRowid }
 */
export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/**
 * 事务包装：任一步骤抛错则整体回滚
 * @param {() => any} fn 事务内逻辑
 */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 当前本地时间字符串，统一时间格式 'YYYY-MM-DD HH:mm:ss' */
export function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 今天日期字符串 'YYYY-MM-DD' */
export function today() {
  return nowStr().slice(0, 10);
}

/** 在指定日期上加减天数，返回 'YYYY-MM-DD' */
export function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
